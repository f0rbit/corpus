export type Mutation = {
	readonly id: string;
	readonly file: string;
	readonly find: string;
	readonly replace: string;
	readonly guards: string;
};

export type MutationManifest = {
	readonly cluster: string;
	readonly old_tests: readonly string[];
	readonly new_tests: readonly string[];
	readonly mutations: readonly Mutation[];
};
