import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const docsDir = join(rootDir, "docs/src/content/docs");

const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));

const readFile = (path) => readFileSync(join(rootDir, path), "utf-8");

// ---------------------------------------------------------------------------
// Docs site URL (derived from astro config)
// ---------------------------------------------------------------------------

const astroConfig = readFile("docs/astro.config.mjs");
const site = astroConfig.match(/\bsite:\s*['"]([^'"]+)['"]/)?.[1] ?? "https://f0rbit.github.io";
const base = astroConfig.match(/\bbase:\s*['"]([^'"]+)['"]/)?.[1] ?? "/corpus";
const docsSite = `${site}${base}`;

// ---------------------------------------------------------------------------
// Entry points (derived from package.json "exports")
// ---------------------------------------------------------------------------

const distToSource = (distPath) => {
	const candidate = distPath.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
	return existsSync(join(rootDir, candidate)) ? candidate : null;
};

const extractModuleDoc = (content) => {
	const match = content.match(/^\/\*\*([\s\S]*?)\*\//);
	if (!match) return "";
	const lines = match[1].split("\n").map((l) => l.replace(/^\s*\*\s?/, ""));
	const prose = [];
	for (const line of lines) {
		const cleaned = line.replace(/^@description\s+/, "").trim();
		if (cleaned.startsWith("@")) continue;
		if (cleaned === "") {
			if (prose.length > 0) break;
			continue;
		}
		prose.push(cleaned);
	}
	return prose.join(" ");
};

const getEntryPoints = () => {
	const entries = [];
	for (const [spec, target] of Object.entries(pkg.exports)) {
		const dist = typeof target === "string" ? target : target.import;
		const source = distToSource(dist);
		if (!source) continue;
		const specifier = spec === "." ? pkg.name : `${pkg.name}${spec.slice(1)}`;
		const doc = extractModuleDoc(readFile(source));
		entries.push({ specifier, source, description: doc || (spec === "." ? pkg.description : "") });
	}
	return entries;
};

// ---------------------------------------------------------------------------
// Public API surface (derived by walking re-exports from the entry points)
// ---------------------------------------------------------------------------

const resolveModule = (fromFile, spec) => {
	if (!spec.startsWith(".")) return null;
	const resolved = posix.join(posix.dirname(fromFile), spec).replace(/\.js$/, ".ts");
	return existsSync(join(rootDir, resolved)) ? resolved : null;
};

const parseNamed = (inner) =>
	inner
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((item) => {
			const isType = item.startsWith("type ");
			const parts = item.replace(/^type\s+/, "").split(/\s+as\s+/);
			return { name: parts[parts.length - 1].trim(), isType };
		});

const NAMED_REEXPORT = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs;
const STAR_REEXPORT = /export\s*\*\s*(?:as\s+(\w+)\s+)?from\s*['"]([^'"]+)['"]/g;

const bucketFor = (surface, module) => {
	if (!surface.has(module)) surface.set(module, { values: new Set(), types: new Set(), namespaces: new Set() });
	return surface.get(module);
};

const collectDirectExports = (content, bucket) => {
	const stripped = content.replace(NAMED_REEXPORT, "").replace(STAR_REEXPORT, "");

	for (const m of stripped.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) bucket.values.add(m[1]);
	for (const m of stripped.matchAll(/export\s+const\s+(\w+)/g)) bucket.values.add(m[1]);
	for (const m of stripped.matchAll(/export\s+class\s+(\w+)/g)) bucket.values.add(m[1]);
	for (const m of stripped.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) bucket.types.add(m[1]);
	for (const m of stripped.matchAll(/export\s+(type\s+)?\{([^}]*)\}/gs)) {
		for (const item of parseNamed(m[2])) {
			(m[1] || item.isType ? bucket.types : bucket.values).add(item.name);
		}
	}
};

const collectSurface = (file, surface, seen) => {
	if (seen.has(file)) return surface;
	seen.add(file);
	const content = readFile(file);

	for (const m of content.matchAll(NAMED_REEXPORT)) {
		const module = resolveModule(file, m[3]) ?? m[3];
		const bucket = bucketFor(surface, module);
		for (const item of parseNamed(m[2])) {
			(m[1] || item.isType ? bucket.types : bucket.values).add(item.name);
		}
	}

	for (const m of content.matchAll(STAR_REEXPORT)) {
		const module = resolveModule(file, m[2]);
		if (m[1]) {
			bucketFor(surface, module ?? m[2]).namespaces.add(m[1]);
			continue;
		}
		if (module) collectSurface(module, surface, seen);
	}

	collectDirectExports(content, bucketFor(surface, file));
	return surface;
};

const getSurface = (entryPoints) => {
	const surface = new Map();
	const seen = new Set();
	for (const entry of entryPoints) collectSurface(entry.source, surface, seen);
	return surface;
};

// ---------------------------------------------------------------------------
// Docs pages (derived from MDX frontmatter)
// ---------------------------------------------------------------------------

const extractFrontmatter = (mdxContent) => {
	const frontmatterMatch = mdxContent.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return {};

	const fm = {};
	const lines = frontmatterMatch[1].split("\n");
	for (const line of lines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line
				.slice(colonIdx + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
			fm[key] = value;
		}
	}
	return fm;
};

const stripFrontmatter = (mdxContent) => mdxContent.replace(/^---\n[\s\S]*?\n---\n?/, "");

const getMdxDocs = () => {
	const docs = [];
	const walkDir = (dir, basePath = "") => {
		if (!existsSync(dir)) return;
		const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walkDir(fullPath, relativePath);
			} else if (entry.name.endsWith(".mdx")) {
				const content = readFileSync(fullPath, "utf-8");
				const frontmatter = extractFrontmatter(content);
				const slug = relativePath.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "");
				docs.push({
					path: relativePath,
					slug,
					url: `${docsSite}/${slug ? `${slug}/` : ""}`,
					title: frontmatter.title || (slug === "" ? pkg.name : entry.name.replace(".mdx", "")),
					description: frontmatter.description || "",
					body: stripFrontmatter(content).trim(),
				});
			}
		}
	};
	walkDir(docsDir);
	return docs;
};

const groupDocs = (docs) => {
	const groups = new Map();
	for (const doc of docs) {
		const segment = doc.path.includes("/") ? doc.path.slice(0, doc.path.indexOf("/")) : "";
		if (!groups.has(segment)) groups.set(segment, []);
		groups.get(segment).push(doc);
	}
	const ordered = [...groups.entries()].toSorted(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
	return ordered;
};

// ---------------------------------------------------------------------------
// Quickstart examples (derived from the getting-started page)
// ---------------------------------------------------------------------------

const dedent = (code) => {
	const lines = code.split("\n");
	const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
	const min = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.slice(min)).join("\n");
};

const extractCodeExamples = (mdxContent) => {
	const examples = [];
	const codeBlockRegex = /```(?:typescript|ts|tsx)\n([\s\S]*?)```/g;
	let match;
	while ((match = codeBlockRegex.exec(mdxContent)) !== null) {
		const code = dedent(match[1]).trim();
		if (code.length > 0 && code.length < 1500) {
			examples.push(code);
		}
	}
	return examples;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const renderCodes = (names) => [...names].map((n) => `\`${n}\``).join(", ");

const renderSurface = (surface) => {
	const sections = [];
	for (const [module, bucket] of surface) {
		if (bucket.values.size === 0 && bucket.types.size === 0 && bucket.namespaces.size === 0) continue;
		const lines = [`### ${module}`];
		if (bucket.namespaces.size > 0)
			lines.push(
				`Namespace re-export: ${renderCodes(bucket.namespaces)} (e.g. \`import { ${[...bucket.namespaces][0]} } from '${pkg.name}'\`)`,
			);
		if (bucket.values.size > 0) lines.push(`- Values: ${renderCodes(bucket.values)}`);
		if (bucket.types.size > 0) lines.push(`- Types: ${renderCodes(bucket.types)}`);
		sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
};

const renderDocsIndex = (docs) => {
	const sections = [];
	for (const [segment, pages] of groupDocs(docs)) {
		const heading = segment === "" ? "Overview" : segment.charAt(0).toUpperCase() + segment.slice(1);
		const lines = pages.map((p) => `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ""}`);
		sections.push(`### ${heading}\n${lines.join("\n")}`);
	}
	return sections.join("\n\n");
};

const generateLlmsTxt = () => {
	const entryPoints = getEntryPoints();
	const surface = getSurface(entryPoints);
	const docs = getMdxDocs();
	const gettingStarted = docs.find((d) => d.path === "getting-started.mdx");
	const quickstart = gettingStarted ? extractCodeExamples(gettingStarted.body).slice(0, 3) : [];

	return `# ${pkg.name} v${pkg.version}

> ${pkg.description}

Install: \`bun add ${pkg.name} zod\` (or npm/pnpm/yarn). Peer dependencies: ${Object.entries(pkg.peerDependencies ?? {})
		.map(([name, range]) => `\`${name} ${range}\``)
		.join(", ")}.

Full docs for LLM consumption: ${docsSite}/llms-full.txt

## Entry Points

${entryPoints.map((e) => `- \`${e.specifier}\` (\`${e.source}\`)${e.description ? ` — ${e.description}` : ""}`).join("\n")}

## Documentation

${renderDocsIndex(docs)}

## Quickstart

${quickstart.map((code) => `\`\`\`typescript\n${code}\n\`\`\``).join("\n\n")}

## API Surface

Every public export, grouped by the source module that defines it.

${renderSurface(surface)}

## Links

- Documentation: ${docsSite}
- Repository: ${pkg.repository?.url || "https://github.com/f0rbit/corpus"}
`;
};

// ---------------------------------------------------------------------------
// Full docs (compact index + every docs page + all reachable source files)
// ---------------------------------------------------------------------------

const collectSourceFiles = (roots) => {
	const seen = new Set();
	const queue = [...roots];
	while (queue.length > 0) {
		const file = queue.shift();
		if (seen.has(file)) continue;
		seen.add(file);
		const content = readFile(file);
		for (const m of content.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
			const resolved = resolveModule(file, m[1]);
			if (resolved && !seen.has(resolved)) queue.push(resolved);
		}
	}
	return [...seen].toSorted();
};

const generateLlmsFullTxt = (conciseTxt) => {
	const entryPoints = getEntryPoints();
	const roots = entryPoints.map((e) => e.source);
	const registerHook = pkg.corpus?.testing ? distToSource(pkg.corpus.testing) : null;
	if (registerHook) roots.push(registerHook);
	const sourceFiles = collectSourceFiles(roots);
	const docs = getMdxDocs();

	const docsSection = docs
		.map((d) => `### ${d.title} (${d.path})\n\n${d.description ? `> ${d.description}\n\n` : ""}${d.body}`)
		.join("\n\n---\n\n");

	const sourceSection = sourceFiles
		.map((f) => `### ${f}\n\n\`\`\`typescript\n${readFile(f)}\n\`\`\``)
		.join("\n\n---\n\n");

	return `# ${pkg.name} v${pkg.version} - Full Documentation

> ${pkg.description}

This document contains the compact reference, every documentation page, and the full public source code for LLM consumption.

${conciseTxt}

---

## Documentation Pages

${docsSection}

---

## Full Source Code

All source files reachable from the public entry points.

${sourceSection}
`;
};

const llmsTxt = generateLlmsTxt();
const llmsFullTxt = generateLlmsFullTxt(llmsTxt);

writeFileSync(join(rootDir, "docs/public/llms.txt"), llmsTxt);
console.log("Generated docs/public/llms.txt");

writeFileSync(join(rootDir, "docs/public/llms-full.txt"), llmsFullTxt);
console.log("Generated docs/public/llms-full.txt");

console.log("\nLLM docs generated successfully!");
