#!/usr/bin/env node
/**
 * OpenSkills MCP Server
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
/* Helper: Get skills directories in priority order */
/* -------------------------------------------------- */

function getSearchDirs() {
  const cwd = process.cwd();
  const home = os.homedir();
  
  return [
    path.join(cwd, ".agent", "skills"),      // project universal
    path.join(home, ".agent", "skills"),     // global universal
    path.join(cwd, ".claude", "skills"),     // project
    path.join(home, ".claude", "skills"),    // global
  ].filter(dir => fs.existsSync(dir));
}

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
/* Core: Find all skills across all directories */
/* -------------------------------------------------- */

function findAllSkills() {
  const dirs = getSearchDirs();
  const skills = new Map(); // Use Map to deduplicate by name
  
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        
        const skillName = entry.name;
        
        // Skip if we already found this skill (higher priority)
        if (skills.has(skillName)) continue;
        
        const skillPath = path.join(dir, skillName).replace(/\\/g, '/');
        const skillMdPath = path.join(skillPath, "SKILL.md").replace(/\\/g, '/');
        
        // Check if SKILL.md exists
        if (!fs.existsSync(skillMdPath)) continue;
        
        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const name = extractYamlField(content, "name") || skillName;
          const description = extractYamlField(content, "description") || "";
          
          // Determine location type
          let location;
          if (dir.includes(".agent")) {
            location = dir.includes(os.homedir()) ? "global-universal" : "project-universal";
          } else {
            location = dir.includes(os.homedir()) ? "global" : "project";
          }
          
          skills.set(skillName, {
            name,
            description,
            location,
            path: skillPath,
          });
        } catch (err) {
          console.error(`[Warn] Failed to read ${skillMdPath}:`, err.message);
        }
      }
    } catch (err) {
      // Directory might not exist or not readable
      continue;
    }
  }
  
  return Array.from(skills.values());
}

/* -------------------------------------------------- */
/* Core: Find specific skill */
/* -------------------------------------------------- */

function findSkill(skillName) {
  const dirs = getSearchDirs();
  
  for (const dir of dirs) {
    const skillPath = path.join(dir, skillName).replace(/\\/g, '/');;
    const skillMdPath = path.join(skillPath, "SKILL.md").replace(/\\/g, '/');;
    
    if (fs.existsSync(skillMdPath)) {
      return { skillPath, skillMdPath };
    }
  }
  
  return null;
}

/* -------------------------------------------------- */
/* Core: Load skill via direct file read */
/* -------------------------------------------------- */

function loadSkillDirect(skillName) {
  console.error(`[Load] ${skillName}`);
  
  const found = findSkill(skillName);
  if (!found) {
    throw new Error(`Skill not found: ${skillName}`);
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
/* MCP Server */
/* -------------------------------------------------- */

const server = new Server(
  { name: "openskills-mcp", version: "1.1.0" },
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
        "List all available Skills with name, description, and location",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "load_skill",
      description:
        "Load full skill content from SKILL.md and return its base directory",
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

    /* ---------- list_skills ---------- */
    if (name === "list_skills") {
      const skills = findAllSkills();
      
      if (skills.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No skills found. Skills directories checked:\n" +
                    getSearchDirs().join("\n"),
            },
          ],
        };
      }
      
      // Format as simple list
      let output = `Available Skills (${skills.length}):\n\n`;
      
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
      const { skill_name } = args;
      const { skillName, baseDir, content } = loadSkillDirect(skill_name);

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
========================================
SKILL LOADED
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
SKILL CONTENT
----------------------------------------

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