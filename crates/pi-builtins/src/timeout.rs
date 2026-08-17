//! `timeout` builtin, moved from `pi-shell`.

use std::{future::Future, io::Write, time::Duration};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo, builtins,
};
use clap::Parser;
use tokio::time;
use tokio_util::sync::CancellationToken;

use crate::host::{parse_duration, quote_arg};

/// Run a command with a time limit.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct TimeoutCommand {
	#[arg(required = true)]
	duration: String,
	#[arg(required = true, num_args = 1.., trailing_var_arg = true)]
	command: Vec<String>,
}

impl builtins::Command for TimeoutCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let duration = self.duration.clone();
		let command = self.command.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let Some(timeout) = parse_duration(&duration) else {
				let _ = writeln!(context.stderr(), "timeout: invalid time interval '{duration}'");
				return Ok(ExecutionResult::new(125));
			};
			if command.is_empty() {
				let _ = writeln!(context.stderr(), "timeout: missing command");
				return Ok(ExecutionResult::new(125));
			}

			let child_cancel = CancellationToken::new();
			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			params.set_cancel_token(child_cancel.clone());

			let mut command_line = String::new();
			for (idx, arg) in command.iter().enumerate() {
				if idx > 0 {
					command_line.push(' ');
				}
				command_line.push_str(&quote_arg(arg));
			}

			let cancel_token = context.cancel_token();
			let source_info = SourceInfo::from("pi-natives:timeout");
			let run_future = context.shell.run_string(command_line, &source_info, &params);
			tokio::pin!(run_future);

			if let Some(cancel_token) = cancel_token {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						// Wait briefly for the child to exit after cancellation.
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						Ok(ExecutionResult::new(124))
					},
					() = cancel_token.cancelled() => {
						child_cancel.cancel();
						Ok(ExecutionExitCode::Interrupted.into())
					},
				}
			} else {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						// Wait briefly for the child to exit after cancellation.
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						Ok(ExecutionResult::new(124))
					},
				}
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::{Read, Seek, SeekFrom},
		time::Duration,
	};

	use brush_core::{
		ExecutionContext, ExecutionResult, Shell, SourceInfo, builtins,
		extensions::DefaultShellExtensions,
		openfiles::OpenFiles,
	};
	use clap::Parser;

	use super::TimeoutCommand;

	#[derive(Parser)]
	struct StatusCommand;

	impl builtins::Command for StatusCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			_context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			Ok(ExecutionResult::new(7))
		}
	}

	#[derive(Parser)]
	struct SlowCommand;

	impl builtins::Command for SlowCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			let cancel_token = context
				.cancel_token()
				.expect("timeout must provide its operand a cancellation token");
			tokio::select! {
				() = cancel_token.cancelled() => Ok(ExecutionResult::success()),
				() = tokio::time::sleep(Duration::from_millis(500)) => {
					Ok(ExecutionResult::new(99))
				},
			}
		}
	}

	async fn test_shell() -> Shell<DefaultShellExtensions> {
		Shell::builder()
			.builtin(
				"timeout",
				builtins::builtin::<TimeoutCommand, DefaultShellExtensions>(),
			)
			.builtin(
				"status-test",
				builtins::builtin::<StatusCommand, DefaultShellExtensions>(),
			)
			.builtin(
				"slow-test",
				builtins::builtin::<SlowCommand, DefaultShellExtensions>(),
			)
			.build()
			.await
			.expect("build test shell")
	}

	async fn run_with_deadline(command: &str) -> ExecutionResult {
		let mut shell = test_shell().await;
		let mut params = shell.default_exec_params();
		// Cancelling the operand makes the shell report an interrupted command;
		// without this the diagnostic lands on the test runner's terminal.
		for fd in [OpenFiles::STDIN_FD, OpenFiles::STDOUT_FD, OpenFiles::STDERR_FD] {
			params.set_fd(fd, brush_core::openfiles::null().expect("null device"));
		}
		tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(command, &SourceInfo::default(), &params),
		)
		.await
		.expect("timeout builtin test exceeded its safety deadline")
		.expect("execute test command")
	}

	#[tokio::test]
	async fn command_finishing_inside_limit_returns_its_status() {
		let result = run_with_deadline("timeout 0.250 status-test").await;

		assert_eq!(u8::from(result.exit_code), 7);
	}

	#[tokio::test]
	async fn command_exceeding_limit_is_cancelled_with_timeout_status() {
		let result = run_with_deadline("timeout 0.010 slow-test").await;

		assert_eq!(u8::from(result.exit_code), 124);
	}

	#[tokio::test]
	async fn invalid_duration_preserves_diagnostic() {
		let mut shell = test_shell().await;
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		let mut params = shell.default_exec_params();
		params.set_fd(
			OpenFiles::STDERR_FD,
			stderr.try_clone().expect("clone stderr capture").into(),
		);

		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(
				"timeout invalid status-test",
				&SourceInfo::default(),
				&params,
			),
		)
		.await
		.expect("invalid-duration test exceeded its safety deadline")
		.expect("execute invalid-duration command");
		stderr.seek(SeekFrom::Start(0)).expect("rewind stderr capture");
		let mut diagnostic = String::new();
		stderr.read_to_string(&mut diagnostic).expect("read stderr capture");

		assert_eq!(u8::from(result.exit_code), 125);
		assert_eq!(diagnostic, "timeout: invalid time interval 'invalid'\n");
	}
}
