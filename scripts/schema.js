/* Print the schema exactly as the prompt carries it, with its size.
 *
 *   yeet run scripts/schema.js            size and the Query root
 *   yeet run scripts/schema.js --all      the whole rendering
 */

import { loadSchema } from "../app/schema.js";

const started = Date.now();
const schema = await loadSchema((q) => yeet.graph.query(q));
console.log(`${schema.types} types · ${schema.bytes} bytes · ${Date.now() - started}ms · root ${schema.root}`);
console.log(`root fields: ${schema.fields.join(" ")}\n`);
console.log(yeet.args.all ? schema.sdl : schema.sdl.split("\n\n")[0]);
yeet.exit();
