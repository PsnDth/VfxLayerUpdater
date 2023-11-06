// Note: The regex below have multiple versions to handle use within escaped json. Some examples:
//        - `(?:[\s\r\n]|\\r|\\n)*` matches spaces/newlines
//        - `\\?"` matches quotation marks

// Note this looks for the pattern `layer: "front"` (or `"back"` or `"behind"` or some other string)
// Even though `layer: "back"` didn't work, will fix if exists
// Also will capture fixed ones: i.e. `layer: VfxLayer.LAYER_NAME` so that they do not get marked for manual correction
const FIXABLE_LAYER_FRONT_PROPERTY = /(\Wlayer(?:[\s\r\n]|\\r|\\n)*:(?:[\s\r\n]|\\r|\\n)*)(\\?"front\\?")/g;
const FIXABLE_LAYER_BACK_PROPERTY = /(\Wlayer(?:[\s\r\n]|\\r|\\n)*:(?:[\s\r\n]|\\r|\\n)*)(\\?"back\\?")/g;
const FIXABLE_LAYER_BEHIND_PROPERTY = /(\Wlayer(?:[\s\r\n]|\\r|\\n)*:(?:[\s\r\n]|\\r|\\n)*)(\\?"behind\\?")/g;
const HAS_OTHER_LAYER_PROPERTY = /(\Wlayer(?:[\s\r\n]|\\r|\\n)*:(?:[\s\r\n]|\\r|\\n)*)(\\?".*?\\?")/g;

const HAS_LAYER_MATCHER = /\Wlayer:/g;
const HAS_GOOD_LAYER_PROPERTY = /(\Wlayer(?:[\s\r\n]|\\r|\\n)*:(?:[\s\r\n]|\\r|\\n)*)(VfxLayer\.(?:BACKGROUND_BEHIND|BACKGROUND_STRUCTURES|BACKGROUND_SHADOWS|BACKGROUND_EFFECTS|CHARACTERS_BACK|CHARACTERS|CHARACTERS_FRONT|FOREGROUND_STRUCTURES|FOREGROUND_SHADOWS|FOREGROUND_EFFECTS|FOREGROUND_FRONT))/g;

function isEntityOrHScript(fhandle) {
    const is_entity = fhandle.name.endsWith(".entity");
    const is_hscript = fhandle.name.endsWith(".hx");
    return (is_entity || is_hscript);
}

async function countRegexInstances(fhandle, match_re, file_filter) {
    if (!file_filter(fhandle)) return -1;
    // get contents
    const read_handle = await fhandle.getFile();
    var contents = await read_handle.text();
    const matches = ((contents || '').match(match_re) || []);
    return matches.length;
}

async function updateLayerProps(fhandle) {
    const unhandled_locs = await getUnhandledLayerProps(fhandle);
    // get contents
    const read_handle = await fhandle.getFile();
    var contents = await read_handle.text();
    contents = contents || '';
    var num_fixed = 0;
    const front_matches = contents.match(FIXABLE_LAYER_FRONT_PROPERTY) || [];
    if (front_matches.length > 0) {
        console.log(`Found ${front_matches.length} cases of VfxStat layer: "front" in ${read_handle.name}`);
        contents = contents.replace(FIXABLE_LAYER_FRONT_PROPERTY, "$1VfxLayer.CHARACTERS_FRONT");
        num_fixed += front_matches.length;
    }
    const behind_matches = contents.match(FIXABLE_LAYER_BEHIND_PROPERTY) || [];
    if (behind_matches.length > 0) {
        console.log(`Found ${behind_matches.length} cases of VfxStat layer: "behind" in ${read_handle.name}`);
        contents = contents.replace(FIXABLE_LAYER_BEHIND_PROPERTY, "$1VfxLayer.CHARACTERS_BACK");
        num_fixed += behind_matches.length;
    }
    const back_matches = contents.match(FIXABLE_LAYER_BACK_PROPERTY) || [];
    if (back_matches.length > 0) {
        console.log(`Found ${back_matches.length} cases of VfxStat layer: "back" in ${read_handle.name}`);
        contents = contents.replace(FIXABLE_LAYER_BACK_PROPERTY, "$1VfxLayer.CHARACTERS_BACK");
        num_fixed += back_matches.length;
    }
    const other_matches = contents.match(HAS_OTHER_LAYER_PROPERTY) || [];
    if (other_matches.length > 0) {
        console.log(`Found ${other_matches.length} cases of VfxStat layer: "invalid_string" in ${read_handle.name}. Commented them out.`);
        contents = contents.replace(HAS_OTHER_LAYER_PROPERTY, "/*$&*/");
        num_fixed += other_matches.length;
    }
    if (num_fixed > 0) {
        const write_handle = await fhandle.createWritable();
        await write_handle.write(contents);
        await write_handle.close();
    }
    return [...unhandled_locs, num_fixed];
}

function unescapeJSONString(encoded_str) {
    return encoded_str.replace("\\b", "\b")
                      .replace("\\f", "\f")
                      .replace("\\n", "\n")
                      .replace("\\r", "\r")
                      .replace("\\t", "\t")
                      .replace("\\\"", "\"")
                      .replace("\\\\", "\\");
}

function getFrameScriptKeyframes(entity_contents) {
    var layer_to_anim_name = new Map();
    for (const anim of entity_contents["animations"]) {
        for (const layer of anim["layers"]) {
            layer_to_anim_name.set(layer, anim["name"]);
        }
    }
    
    var kf_to_layer = new Map();
    for (const layer of entity_contents["layers"]) {
        if (!layer_to_anim_name.has(layer["$id"])) continue;
        for (const kf of layer["keyframes"]) {
            kf_to_layer.set(kf, layer["$id"]);
        }
    }
    
    var kf_to_anim = new Map();
    for (const entry of kf_to_layer) {
        const [kf, layer] = entry;
        kf_to_anim.set(kf, layer_to_anim_name.get(layer) || "unknown");
    }
    
    return kf_to_anim;
}

async function getEntityLocations(read_handle) {
    // format will be `{filename} Animation {animation} FrameScript`
    const loc_base = `${read_handle.name}`
    const entity_contents = JSON.parse(await read_handle.text());
    const keyframes = getFrameScriptKeyframes(entity_contents);
    var locations = [];
    for (const keyframe of entity_contents["keyframes"]) {
        if (!keyframes.has(keyframe["$id"])) continue;
        const code = unescapeJSONString(keyframe["code"] || "");
        const loc_animation = keyframes.get(keyframe["$id"]);
        locations.push([`${loc_base} @ ${loc_animation}`, code]);
    }
    return locations;
}

async function getHScriptLocations(read_handle) {
    return [[read_handle.name, await read_handle.text()]];
}

async function getLocations(fhandle) {
    const is_entity = fhandle.name.endsWith(".entity");
    const is_hscript = fhandle.name.endsWith(".hx");
    if (is_entity) return getEntityLocations(await fhandle.getFile());
    if (is_hscript) return getHScriptLocations(await fhandle.getFile());
    return [];

}

async function getUnhandledLayerProps(fhandle) {
    if (!isEntityOrHScript(fhandle)) return [];
    var matches = [];
    for (const scriptInfo of (await getLocations(fhandle))) {
        const [loc, script] = scriptInfo; // will also convert script into normal new lines
        var line_no = 1;
        for (const line of script.split("\n")) {
            // Find all matches in line and all fixable matches and try to make sure they have the same indices
            var all_matches = line.matchAll(HAS_LAYER_MATCHER);
            for (const line_match of all_matches) {

                var should_skip_match = false;
                const matches_to_skip = [FIXABLE_LAYER_FRONT_PROPERTY, FIXABLE_LAYER_BACK_PROPERTY, FIXABLE_LAYER_BEHIND_PROPERTY, HAS_OTHER_LAYER_PROPERTY, HAS_GOOD_LAYER_PROPERTY];
                for (const matcher in matches_to_skip) {
                    const results = [...line.substring(line_match.index).matchAll(matcher)];
                    if (results) {
                        should_skip_match = true;
                        break;
                    }
                }
                if (should_skip_match) continue;
                matches.push([`${loc} line ${line_no}`, line]);
                break;
            }
            line_no += 1;
        }
    }
    return matches;
}

async function applyForFolder(dirHandle, func) {
    allRet = [];
    for await (const entry of dirHandle.values()) {
        if (entry.kind == 'file') {
            allRet.push(await func(entry));
        }
        else if (entry.kind == 'directory') {
            // recursion should be optional and have a max depth
            allRet = allRet.concat(await applyForFolder(entry, func));
        }
    }
    return allRet;
}

function combineReturnValues(ret_values) {
    var num_matches = 0;
    var all_unmatched = [];
    for (const ret_value of ret_values) {
        num_matches += ret_value.pop();
        all_unmatched = all_unmatched.concat(ret_value);
    }
    console.log(all_unmatched);
    console.log(num_matches);
    return [all_unmatched, num_matches];
}

function returnValueToHTML(ret_value, type_str) {
    const [all_unmatched, num_matches] = ret_value;
    if (num_matches == 0 && all_unmatched.length == 0) return;
    const unmatched_loc_html = all_unmatched.map(loc => `<code>${loc[0]}<br>${loc[1]}</code>`).join("<br><br>");
    const unmatched_html = all_unmatched.length ? `<br>Wasn't able to change these matches:<br>${unmatched_loc_html}` : "";
    console.log(unmatched_html);
    return `fixed <span>${num_matches}</span> matches of ${type_str}.${unmatched_html}`;
}

window.addEventListener("load", (e) => {
    const result_box = document.getElementById("result");
    const start_button = document.getElementById("start_process");
    const can_modify_fs = ("showDirectoryPicker"  in window);
    if (can_modify_fs) {
        start_button.addEventListener("click", async (event) => {
            window.showDirectoryPicker({ id: "ft_folder", mode: "readwrite" }).then(async (dirHandle) => {
                for await (const entry of dirHandle.values()) {
                    if (entry.name.endsWith(".fraytools")) return dirHandle;
                }
                throw "Couldn't find .fraytools file";
            }).then(async (dirHandle) => {
                const layer_props_res = combineReturnValues(await applyForFolder(dirHandle, updateLayerProps));
                return layer_props_res;
            }).then((layer_props_res) => {
                const layer_props_html = returnValueToHTML(layer_props_res, 'layer VfxStat') || "found no layer VfxStats to fix automatically.";
                result_box.innerHTML = `Successfully ${layer_props_html}`;
                result_box.classList = "desc success_resp";
                console.log("Successfully applied to folder");
            }).catch( (err) => {
                if (!(err instanceof DOMException && err.name == "AbortError")) {
                    result_box.textContent = "Couldn't open provided folder, or folder does not have a .fraytools file. Please try again.";
                    result_box.classList = "desc error_resp";
                    console.error(`Failed to apply to folder. Reason: ${err}`);
                }
            });
        });
    } else {
        start_button.disabled = true;
        result_box.textContent = "Can't access the filesystem directly with this browser 😢. Try using something chromium ...";
        result_box.classList = "desc error_resp";
        console.error(`showDirectoryPicker is not supported in this browser`);
    }
});