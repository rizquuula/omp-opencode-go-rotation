import { readFileSync, writeFileSync } from "node:fs";

const [bump, branch = "main", path = "package.json"] = process.argv.slice(2);
if (bump !== "major" && bump !== "minor" && bump !== "patch") {
	console.error("Usage: bump-version.mjs <major|minor|patch> [branch] [package.json]");
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(path, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(manifest.version ?? "");
if (!match) {
	console.error(`Unsupported version: ${manifest.version}`);
	process.exit(2);
}

let major = Number(match[1]);
let minor = Number(match[2]);
let patch = Number(match[3]);
const prerelease = match[4];

function applyBump() {
	if (bump === "major") {
		major += 1;
		minor = 0;
		patch = 0;
	} else if (bump === "minor") {
		minor += 1;
		patch = 0;
	} else {
		patch += 1;
	}
}

if (branch !== "dev") {
	applyBump();
	manifest.version = `${major}.${minor}.${patch}`;
} else if (prerelease?.startsWith("dev.")) {
	const counter = Number(prerelease.split(".")[1] ?? "0");
	manifest.version = `${major}.${minor}.${patch}-dev.${counter + 1}`;
} else {
	applyBump();
	manifest.version = `${major}.${minor}.${patch}-dev.0`;
}

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifest.version);
