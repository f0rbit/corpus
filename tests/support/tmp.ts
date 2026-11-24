import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const make_tmp_dir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), `corpus-${prefix}-`));

export const remove_tmp_dir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });
