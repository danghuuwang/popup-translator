const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CssMinimizerPlugin = require("css-minimizer-webpack-plugin");

module.exports = (env, argv) => {
  const isProd = argv.mode === "production";
  return {
    entry: {
      background: "./src/background/index.js",
      content: "./src/content/index.js",
      popup: "./src/popup/popup.js",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.css$/,
          use: [MiniCssExtractPlugin.loader, "css-loader"],
        },
      ],
    },
    plugins: [
      new MiniCssExtractPlugin({ filename: "[name].css" }),
      new CopyPlugin({
        patterns: [
          { from: "src/manifest.json", to: "manifest.json" },
          { from: "src/popup/popup.html", to: "popup.html" },
          { from: "src/icons", to: "icons" },
        ],
      }),
    ],
    optimization: {
      minimize: isProd,
      minimizer: [new CssMinimizerPlugin()],
    },
    devtool: isProd ? false : "cheap-module-source-map",
  };
};
