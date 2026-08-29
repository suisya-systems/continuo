/**
 * Install `driver-loader.mjs` for the driver child process.
 *
 * A resolve hook has to be *registered*; passing the hook module itself to
 * `--import` loads it and installs nothing, which fails as a plain
 * `ERR_MODULE_NOT_FOUND` on the first `.js` specifier and looks like a missing
 * file rather than a missing hook. This shim is the registration, and it is what
 * the controller's spawn command names.
 */

import { register } from "node:module";

register("./driver-loader.mjs", import.meta.url);
