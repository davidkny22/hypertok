import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default {
  mode: "production",
  target: "web",
  entry: path.join(directory, "entry.mjs"),
  experiments: { outputModule: true },
  output: {
    path: path.resolve(directory, "../../../results/execution-tiers/bundlers/webpack"),
    filename: "bundle.mjs",
    chunkFilename: "assets/[name]-[contenthash].mjs",
    module: true,
    clean: false,
  },
  optimization: { minimize: false },
};
