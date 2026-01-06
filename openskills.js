#!/usr/bin/env node
/**
 * OpenSkills MCP Server (Minimal + execute_skill)
 *
 * - load_skill: uses `openskills read <skill>`
 * - execute_skill: execute skill scripts via shell command and return stdout/stderr
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync, spawn } from "child_process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/* -------------------------------------------------- */
/* Simple local cache (optional) */
/* -------------------------------------------------- */

const CACHE_FILE = path.join(os.homedir(), ".openskills-mcp-cache.json");
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
    maxBuffer: 10 * 1024 * 1024,
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
    loadedAt: Date.now(),
  });
  saveCache();

  return { skillName, baseDir, rawOutput: output };
}

/* -------------------------------------------------- */
/* MCP Server */
/* -------------------------------------------------- */

const server = new Server(
  { name: "openskills-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

/* -------------------------------------------------- */
/* List tools */
/* -------------------------------------------------- */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "load_skill",
      description:
        "Read an OpenSkill using `openskills read` and return its base directory",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "Skill name (e.g. chrome-devtools)",
          },
        },
        required: ["skill_name"],
      },
    },
    {
      name: "execute_skill",
      description: "Execute skill scripts via shell command and return stdout/stderr",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Shell command to execute",
          },
        },
        required: ["code"],
      },
    },
  ],
}));

/* -------------------------------------------------- */
/* Call tool */
/* -------------------------------------------------- */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    /* ---------- load_skill ---------- */
    if (name === "load_skill") {
      const { skill_name } = args;
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

Skill:
  ${skillName}

(IMPORTANT) SKILL_BASE_DIR:
  ${baseDir}

----------------------------------------
INSTRUCTIONS FOR THE AI
----------------------------------------

You MUST do the following:

1. Treat SKILL_BASE_DIR as canonical for this skill.
2. Remember it for the rest of the conversation.
3. ALWAYS use absolute paths.

Correct:
  node "${baseDir}/scripts/<script>.js"

Incorrect:
  node script.js
  cd scripts && node script.js

----------------------------------------
RAW openskills OUTPUT
----------------------------------------

${rawOutput}
`,
          },
        ],
      };
    }

    /* ---------- execute_skill ---------- */
    if (name === "execute_skill") {
      const { code } = args;

      console.error(`[CMD] ${code}`);

      return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";

        const child = spawn(code, {
          shell: true,
          env: process.env,
          windowsHide: true,
        });

        const timeout = setTimeout(() => {
          child.kill();
          resolve({
            isError: true,
            content: [
              {
                type: "text",
                text: `Command timed out after 60s\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
              },
            ],
          });
        }, 60000);

        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));

        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            resolve({
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Exit code: ${code}\n\nSTDERR:\n${stderr}\n\nSTDOUT:\n${stdout}`,
                },
              ],
            });
          } else {
            resolve({
              content: [{ type: "text", text: stdout || "(no output)" }],
            });
          }
        });

        child.on("error", (err) => {
          clearTimeout(timeout);
          resolve({
            isError: true,
            content: [{ type: "text", text: err.message }],
          });
        });
      });
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err.message}` }],
    };
  }
});

/* -------------------------------------------------- */
/* Start server */
/* -------------------------------------------------- */

const transport = new StdioServerTransport();
await server.connect(transport);
