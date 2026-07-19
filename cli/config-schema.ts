import { z } from "zod";

const store_definition_schema = z.object({
	id: z.string(),
	codec: z.any().optional(),
});

const remote_environment_schema = z.object({
	account_id: z.string().optional(),
	database_id: z.string().optional(),
	bucket: z.string().optional(),
	d1_base_url: z.string().optional(),
	r2_endpoint: z.string().optional(),
});

const file_environment_schema = z.object({
	file: z.string(),
});

const environment_config_schema = z.union([remote_environment_schema, file_environment_schema]);

export const corpus_cli_config_schema = z
	.object({
		stores: z.array(store_definition_schema).optional(),
		environments: z.record(environment_config_schema).optional(),
		default_env: z.string().optional(),
	})
	.strict();

export type CorpusCliConfig = z.infer<typeof corpus_cli_config_schema>;

export function define_config(config: CorpusCliConfig): CorpusCliConfig {
	return config;
}
