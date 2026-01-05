#!/usr/bin/env node
/**
 * OpenSkills MCP Server (Minimal + Correct Spec)
 *
 * - Uses `openskills read <skill-name>` as the single source of truth
 * - Extracts Base directory from command output
 * - Returns explicit AI instructions in tool response
 * - Supports MCP tools correctly
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

/* -------------------------------------------------- */
/* Simple cache (optional, local) */
/* -------------------------------------------------- */

const CACHE_FILE = path.join(
    os.homedir(),
    ".openskills-mcp-cache.json"
);

let skillCache = new Map();

if (fs.existsSync(CACHE_FILE)) {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
        skillCache = new Map(Object.entries(raw));
    } catch {
        skillCache = new Map();
    }
}

function saveCache() {
    fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify(Object.fromEntries(skillCache), null, 2)
    );
}

/* -------------------------------------------------- */
/* Core: load skill via openskills CLI */
/* -------------------------------------------------- */

function loadSkillViaOpenSkills(skillName) {
    console.error(`[Load] openskills read ${skillName}`);

    const output = execSync(`openskills read ${skillName}`, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024
    });

    const match = output.match(/^Base directory:\s*(.+)$/m);
    if (!match) {
        throw new Error("Could not parse Base directory from openskills output");
    }

    const baseDir = match[1].trim();

    if (!fs.existsSync(baseDir)) {
        throw new Error(`Base directory does not exist: ${baseDir}`);
    }

    skillCache.set(skillName, {
        name: skillName,
        baseDir,
        loadedAt: Date.now()
    });

    saveCache();

    return {
        skillName,
        baseDir,
        rawOutput: output
    };
}

/* -------------------------------------------------- */
/* MCP Server */
/* -------------------------------------------------- */

const server = new Server(
    {
        name: "openskills-mcp",
        version: "1.0.0"
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

/* -------------------------------------------------- */
/* List tools */
/* -------------------------------------------------- */

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "load_skill",
                description:
                    "Read a Skill and return its documentation and base directory",
                inputSchema: {
                    type: "object",
                    properties: {
                        skill_name: {
                            type: "string",
                            description: "Skill name (e.g. chrome-devtools)"
                        }
                    },
                    required: ["skill_name"]
                }
            }
        ]
    };
});

/* -------------------------------------------------- */
/* Call tool */
/* -------------------------------------------------- */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        if (request.params.name !== "load_skill") {
            throw new Error(`Unknown tool: ${request.params.name}`);
        }

        const { skill_name } = request.params.arguments;
        const { skillName, baseDir, rawOutput } =
            loadSkillViaOpenSkills(skill_name);

        return {
            content: [
                {
                    type: "text",
                    text: `
========================================
OPEN SKILL LOADED
========================================

Skill name:
  ${skillName}

Base directory (IMPORTANT):
  ${baseDir}

----------------------------------------
INSTRUCTIONS FOR THE AI ASSISTANT
----------------------------------------

You MUST do the following:

1. Treat the path above as the canonical BASE_DIR for this skill.
2. Remember this base directory for the remainder of the conversation.
3. ALWAYS execute scripts using an absolute path.

Correct pattern:
  node "<BASE_DIR>/scripts/<script>.js" [args...]

Incorrect patterns (DO NOT USE):
  cd <BASE_DIR>/scripts && node script.js
  node script.js
  node ./scripts/script.js
4. DO NOT reload this skill unless the user explicitly asks to reload it.

----------------------------------------
RAW OUTPUT FROM openskills
----------------------------------------

${rawOutput}
`
                }
            ]
        };
    } catch (err) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `Error: ${err.message}`
                }
            ]
        };
    }
});

/* -------------------------------------------------- */
/* Start server */
/* -------------------------------------------------- */

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[Server] OpenSkills MCP Server running (stdio)");
