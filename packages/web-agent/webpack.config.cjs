const { builtinModules } = require("node:module");
const path = require("node:path");
const webpack = require("webpack");

const nodeBuiltins = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`])
);

class FailOnNodeBuiltinPlugin {
  apply(compiler) {
    compiler.hooks.normalModuleFactory.tap("FailOnNodeBuiltinPlugin", (factory) => {
      factory.hooks.beforeResolve.tap("FailOnNodeBuiltinPlugin", (request) => {
        if (request && nodeBuiltins.has(request.request)) {
          throw new Error(`Browser bundle imported Node builtin '${request.request}' from ${request.context}`);
        }
      });
    });
  }
}

module.exports = {
  mode: "production",
  target: "web",
  entry: path.resolve(__dirname, "lib/webpack-entry.js"),
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "fledgling-web-agent.js",
    library: {
      name: "FledglingWebAgent",
      type: "umd"
    },
    clean: true
  },
  resolve: {
    extensions: [".js"]
  },
  plugins: [
    new FailOnNodeBuiltinPlugin(),
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify("production")
    })
  ]
};
