export interface CandidateRequest {
	id: string;
	mixturePath: string;
	enrollmentPaths: string[];
}

export interface CandidateResult {
	id: string;
	audioPath: string | null;
	sampleRate: number;
	loadMs: number;
	inferenceMs: number;
	endpointMs?: number;
	rssBytes: number;
}

export interface SpeechCandidate {
	prepare(): Promise<{ loadMs: number; rssBytes: number }>;
	extract(request: CandidateRequest): Promise<CandidateResult>;
	close(): Promise<void>;
}
