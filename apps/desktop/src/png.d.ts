/** Static asset imports (bundler copies them into dist). */
declare module "*.png" {
	const src: string;
	export default src;
}
declare module "*.svg" {
	const src: string;
	export default src;
}
