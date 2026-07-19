/**
 * HTTP server fake for Amazon S3 compatible storage (used by R2), serving
 * GET/PUT/HEAD/DELETE operations with minimal envelope.
 *
 * Supports both path-style (/{bucket}/{key}) and virtual-host style
 * ({bucket}.{host}/{key}) URLs. Ignores SigV4 authentication headers;
 * real signature validation would be redundant in tests.
 */

export type FakeS3Server = {
	url: string;
	stop: () => void;
	has: (key: string) => boolean;
	keys: () => string[];
};

const s3_404_xml = (key: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>${escape_xml(key)}</Key>
</Error>`;

const escape_xml = (text: string): string =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

const parse_s3_path = (url: URL): { bucket: string; key: string } | null => {
	const hostname = url.hostname;

	// Try virtual-host style first: {bucket}.{host}
	// e.g., mybucket.s3.amazonaws.com -> bucket=mybucket, key from pathname
	if (hostname.includes(".")) {
		const parts = hostname.split(".");
		if (parts.length >= 2) {
			const bucket = parts[0]!;
			let key = url.pathname;
			// Remove leading slash
			if (key.startsWith("/")) {
				key = key.slice(1);
			}
			if (key) {
				return { bucket, key };
			}
		}
	}

	// Fall back to path-style: /{bucket}/{key}
	const path = url.pathname;
	if (path.startsWith("/")) {
		const parts = path.slice(1).split("/");
		if (parts.length >= 2) {
			const bucket = parts[0]!;
			const key = parts.slice(1).join("/");
			if (bucket && key) {
				return { bucket, key };
			}
		}
	}

	return null;
};

export function create_fake_s3(): FakeS3Server {
	const objects = new Map<string, Uint8Array>();

	const server = Bun.serve({
		port: 0,
		fetch: async (request: Request) => {
			const url = new URL(request.url);
			const parsed = parse_s3_path(url);

			if (!parsed) {
				return new Response("Bad Request", { status: 400 });
			}

			// The bucket segment is parsed but unused — the fake is single-bucket
			// (one Map for all objects), matching how Bun.S3Client's `bucket`
			// config option is only ever exercised, never asserted against here.
			const { key } = parsed;

			const method = request.method.toUpperCase();

			switch (method) {
				case "GET": {
					const bytes = objects.get(key);
					if (bytes === undefined) {
						return new Response(s3_404_xml(key), {
							status: 404,
							headers: {
								"Content-Type": "application/xml",
							},
						});
					}
					return new Response(bytes.slice(), {
						status: 200,
						headers: {
							"Content-Type": "application/octet-stream",
							"Content-Length": String(bytes.length),
						},
					});
				}

				case "HEAD": {
					const bytes = objects.get(key);
					if (bytes === undefined) {
						return new Response("", {
							status: 404,
							headers: {
								"Content-Type": "application/xml",
							},
						});
					}
					return new Response("", {
						status: 200,
						headers: {
							"Content-Length": String(bytes.length),
							"Content-Type": "application/octet-stream",
						},
					});
				}

				case "PUT": {
					const body = await request.arrayBuffer();
					const bytes = new Uint8Array(body);
					objects.set(key, bytes.slice());
					return new Response("", {
						status: 200,
						headers: {
							ETag: `"${key}"`,
						},
					});
				}

				case "DELETE": {
					objects.delete(key);
					return new Response("", {
						status: 204,
					});
				}

				default:
					return new Response("Method Not Allowed", { status: 405 });
			}
		},
	});

	const port = server.port ?? 0;
	const url = `http://localhost:${String(port)}`;

	return {
		url,
		stop: () => {
			void server.stop();
		},
		has: (key: string) => objects.has(key),
		keys: () => [...objects.keys()],
	};
}
