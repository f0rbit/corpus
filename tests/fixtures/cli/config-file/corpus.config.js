export default {
	stores: [
		{
			id: "test-store",
			codec: {
				content_type: "application/json",
				encode: (value) => JSON.stringify(value),
				decode: (data) => JSON.parse(data),
			},
		},
	],
	environments: {
		prod: {
			account_id: "config-account-789",
			database_id: "cccccccc-dddd-eeee-ffff-gggggggggggg",
			bucket: "config-bucket",
		},
		local: {
			file: "/tmp/corpus-local",
		},
	},
	default_env: "prod",
};
