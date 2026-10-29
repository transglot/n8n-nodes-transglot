// Copies node icons (*.svg) into dist/ next to their compiled *.node.js so n8n can
// resolve `icon: 'file:transglot.svg'` at runtime. tsc only emits JS/d.ts, so this
// tiny zero-dependency step stands in for the gulp "build:icons" task the n8n starter
// uses — keeping the compiler itself plain `tsc`.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const sourceDirs = [join(root, 'nodes'), join(root, 'credentials')];

/** @param {string} dir */
function walk(dir) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
		} else if (entry.name.endsWith('.svg') || entry.name.endsWith('.png')) {
			const rel = relative(root, full);
			const dest = join(root, 'dist', rel);
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(full, dest);
			console.log(`copied ${rel} -> dist/${rel}`);
		}
	}
}

for (const dir of sourceDirs) walk(dir);
