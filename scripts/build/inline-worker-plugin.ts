import { build, type BuildOptions, type PluginBuild } from "esbuild";

export function inlineWorkerPlugin(config: BuildOptions = {}) {
	return {
		name: "esbuild-plugin-inline-worker",

		setup(buildContext: PluginBuild) {
			buildContext.onLoad(
				// EXPL: Apply to any .worker.XX file
				{ filter: /\.worker\.(js|jsx|ts|tsx)$/ },
				async ({ path: workerPath }) => {
					// EXPL: Build the worker code in-memory
					const workerBundle = await build({
						...config,
						entryPoints: [workerPath],
						bundle: true,
						write: false,
						format: "iife",
					});

					// EXPL: Extract the code as a string
					const workerCode = workerBundle.outputFiles![0]!.text;

					// EXPL: Wrap the worker code in a class that creates a Blob URL
					return {
						loader: "js",
						contents: `
                            export default class InlineWorker extends Worker {
                                constructor(options) {
                                    const blob = new Blob([${
							JSON.stringify(workerCode)
						}], { type: 'application/javascript' });
                                    const url = URL.createObjectURL(blob);
                                    super(url, options);
                                    URL.revokeObjectURL(url);
                                }
                            }
                        `,
					};
				},
			);
		},
	};
}
