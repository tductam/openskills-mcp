#!/usr/bin/env node
/**
 * Skills MCP Server
 * - list_skills: list all available skills with name, description, location
 * - load_skill: load full skill content from SKILL.md
 * - execute_skill: execute skill scripts via shell command
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
/* Helper: Extract YAML frontmatter from SKILL.md */
/* -------------------------------------------------- */

function extractYamlField(content, field) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const fieldRegex = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const fieldMatch = yaml.match(fieldRegex);

  return fieldMatch ? fieldMatch[1].trim() : null;
}

/* -------------------------------------------------- */
/* Core: Find all skills in a specific directory */
/* -------------------------------------------------- */

function findSkillsInDir(skillsDir) {
  // Expand ~ to home directory
  const expandedDir = skillsDir.startsWith("~")
    ? path.join(os.homedir(), skillsDir.slice(1))
    : skillsDir;

  // Resolve to absolute path
  const absoluteDir = path.resolve(expandedDir);

  if (!fs.existsSync(absoluteDir)) {
    throw new Error(`Skills directory does not exist: ${absoluteDir}`);
  }

  const skills = [];

  try {
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const skillName = entry.name;
      const skillPath = path.join(absoluteDir, skillName).replace(/\\/g, '/');
      const skillMdPath = path.join(skillPath, "SKILL.md").replace(/\\/g, '/');

      // Check if SKILL.md exists
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const rawDescription = extractYamlField(content, "description");
        if (!rawDescription || rawDescription.trim().length === 0) {
          continue; 
        }
        const name = extractYamlField(content, "name") || skillName;
        const description = extractYamlField(content, "description") || "";

        skills.push({
          name,
          description,
          path: skillPath,
        });
      } catch (err) {
        console.error(`[Warn] Failed to read ${skillMdPath}:`, err.message);
      }
    }
  } catch (err) {
    throw new Error(`Failed to read directory ${absoluteDir}: ${err.message}`);
  }

  return skills;
}

/* -------------------------------------------------- */
/* Core: Find specific skill in specific directory */
/* -------------------------------------------------- */

function findSkillInDir(skillName, skillsDir) {
  // Expand ~ to home directory
  const expandedDir = skillsDir.startsWith("~")
    ? path.join(os.homedir(), skillsDir.slice(1))
    : skillsDir;

  // Resolve to absolute path
  const absoluteDir = path.resolve(expandedDir);

  const skillPath = path.join(absoluteDir, skillName).replace(/\\/g, '/');
  const skillMdPath = path.join(skillPath, "SKILL.md").replace(/\\/g, '/');

  if (fs.existsSync(skillMdPath)) {
    return { skillPath, skillMdPath };
  }

  return null;
}

/* -------------------------------------------------- */
/* Core: Load skill from specific directory */
/* -------------------------------------------------- */

function loadSkillFromDir(skillName, skillsDir) {
  console.error(`[Load] ${skillName} from ${skillsDir}`);

  const found = findSkillInDir(skillName, skillsDir);
  if (!found) {
    throw new Error(`Skill "${skillName}" not found in: ${skillsDir}`);
  }

  const { skillPath, skillMdPath } = found;
  const content = fs.readFileSync(skillMdPath, "utf-8");

  return {
    skillName,
    baseDir: skillPath,
    content: content.trim(),
  };
}

/* -------------------------------------------------- */
/* Simple local cache (optional) */
/* -------------------------------------------------- */

const CACHE_FILE = path.join(os.homedir(), ".skills-mcp-cache.json");
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
/* MCP Server */
/* -------------------------------------------------- */

const server = new Server(
  { name: "skills-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

/* -------------------------------------------------- */
/* List tools */
/* -------------------------------------------------- */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_skills",
      description:
        "List all Skills in a specific directory with name, description, and location",
      inputSchema: {
        type: "object",
        properties: {
          skills_dir: {
            type: "string",
            description: "Path to skills directory (e.g. /path/to/.claude/skills or ~/.agent/skills)",
          },
        },
        required: ["skills_dir"],
      },
    },
    {
      name: "load_skill",
      description:
        "Load full skill content from SKILL.md in a specific directory",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "Skill name (e.g. chrome-devtools)",
          },
          skills_dir: {
            type: "string",
            description: "Path to skills directory (same path used in list_skills)",
          },
        },
        required: ["skill_name", "skills_dir"],
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

    /* ---------- list_skills ---------- */
    if (name === "list_skills") {
      const { skills_dir } = args;

      const skills = findSkillsInDir(skills_dir);

      if (skills.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No skills found in: ${path.resolve(skills_dir.startsWith("~") ? path.join(os.homedir(), skills_dir.slice(1)) : skills_dir)}\n\nMake sure the directory contains skill folders with SKILL.md files.`,
            },
          ],
        };
      }

      // Format as simple list
      let output = `Available Skills in ${path.resolve(skills_dir.startsWith("~") ? path.join(os.homedir(), skills_dir.slice(1)) : skills_dir)} (${skills.length}):\n\n`;

      for (const skill of skills) {
        output += `Skill: ${skill.name}\n`;
        output += `Description: ${skill.description}\n`;
        output += `\n`;
      }

      output += "Use 'load_skill' with the skill name to load full instructions.";

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    }

    /* ---------- load_skill ---------- */
    if (name === "load_skill") {
      const { skill_name, skills_dir } = args;
      const { skillName, baseDir, content } = loadSkillFromDir(skill_name, skills_dir);

      skillCache.set(skillName, {
        name: skillName,
        baseDir,
        loadedAt: Date.now(),
      });
      saveCache();

      return {
        content: [
          {
            type: "text",
            text: `
(IMPORTANT) SKILL_BASE_DIR:
  ${baseDir}

${content}
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