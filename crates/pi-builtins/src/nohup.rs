//! The `nohup` command, moved from `pi-shell`.
//!
//! This builtin detaches a backgrounded operand into a new session so a server
//! survives the embedded shell's kill-on-drop teardown. A system `nohup` does
//! not escape the process-group kill, so this command intentionally shadows it.
//! Registration marks it as a transparent background wrapper, allowing brush to
//! spawn the operand directly with session reparenting.

use std::{future::Future, io::Write};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo, builtins,
};
use clap::Parser;

use crate::host::quote_arg;

/// Runs an operand with the process-group policy required by `nohup`.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct NohupCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	command: Vec<String>,
}

impl builtins::Command for NohupCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let command = self.command.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			// coreutils `nohup` with no operand fails with exit code 125.
			if command.is_empty() {
				return Ok(report_missing_operand(context.stderr()));
			}

			// `nohup <cmd>` (foreground) runs the operand directly and surfaces its
			// exit status. Persistence across the host's teardown is a *background*
			// concern that never reaches this builtin: brush's
			// `transparent_background_wrapper` unwraps `nohup <server> &` to spawn the
			// operand directly with session reparenting, double-forking it out of the
			// shell's descendant tree. Like coreutils, we run the operand here; we only
			// differ by not masking SIGHUP.
			let command_line = rebuild_command_line(&command);

			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			let source_info = SourceInfo::from("pi-natives:nohup");
			context
				.shell
				.run_string(command_line, &source_info, &params)
				.await
		}
	}
}

fn report_missing_operand(mut stderr: impl Write) -> ExecutionResult {
	let _ = writeln!(stderr, "nohup: missing operand");
	ExecutionResult::new(125)
}

fn rebuild_command_line(command: &[String]) -> String {
	let mut command_line = String::new();
	for (idx, arg) in command.iter().enumerate() {
		if idx > 0 {
			command_line.push(' ');
		}
		command_line.push_str(&quote_arg(arg));
	}
	command_line
}

#[cfg(test)]
mod tests {
	use super::{rebuild_command_line, report_missing_operand};

	#[test]
	fn missing_operand_reports_diagnostic_and_exit_code() {
		let mut stderr = Vec::new();
		let result = report_missing_operand(&mut stderr);

		assert_eq!(u8::from(result.exit_code), 125);
		assert_eq!(stderr, b"nohup: missing operand\n");
	}

	#[test]
	fn rebuilds_command_line_with_shell_quoting() {
		let command = [
			"printf".to_string(),
			"%s %s".to_string(),
			"two words".to_string(),
			"it's".to_string(),
			String::new(),
		];

		assert_eq!(
			rebuild_command_line(&command),
			"printf '%s %s' 'two words' 'it'\"'\"'s' ''"
		);
	}
}
