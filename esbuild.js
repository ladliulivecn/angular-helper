const esbuild = require('esbuild');
const production = process.argv.includes('--production');

async function build() {
	const result = await esbuild.build({
		entryPoints: ['./src/extension.ts'],
		bundle: true,
		outfile: 'dist/extension.js',
		external: [
			'vscode',
			'typescript',
			'path',
			'fs',
			'util'
		],
		platform: 'node',
		target: 'node16',
		minify: production,
		sourcemap: !production,
		treeShaking: true,
		format: 'cjs',
		define: {
			'process.env.NODE_ENV': production ? '"production"' : '"development"'
		},
		metafile: true,
		mainFields: ['module', 'main'],
		bundle: true,
		logLevel: 'info',
		drop: production ? ['console', 'debugger'] : [],
		pure: production ? ['console.log', 'console.info', 'console.debug', 'console.trace'] : [],
	});

	if (production) {
		const text = await esbuild.analyzeMetafile(result.metafile);
		console.log('构建分析:\n' + text);
	}
}

build().catch((err) => {
	console.error('构建失败:', err);
	process.exit(1);
});
