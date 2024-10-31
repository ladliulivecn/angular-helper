const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');

async function build() {
	const context = await esbuild.context({
		entryPoints: ['./src/extension.ts'],
		bundle: true,
		outfile: 'dist/extension.js',
		external: ['vscode'],
		format: 'cjs',
		platform: 'node',
		target: 'node16',
		sourcemap: !production,
		minify: production,
		mainFields: ['module', 'main'],
		define: {
			'process.env.NODE_ENV': production ? '"production"' : '"development"'
		}
	});

	if (process.argv.includes('--watch')) {
		await context.watch();
	} else {
		await context.rebuild();
		await context.dispose();
	}
}

build().catch((err) => {
	console.error(err);
	process.exit(1);
});
