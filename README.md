## Installation

1.  Clone this repository or navigate to the directory.
2.  Install dependencies:

    ```bash
    npm install
    ```

## Instruction

Define skill file path in the instruction
Take instruction from AGENT.md
Change file path here
```
<configuration>
  <default_skills_dir>path/to/skill</default_skills_dir>
</configuration>
```

### Configuration

```json
{
  "mcpServers": {
    "openskills": {
      "command": "node",
      "args": [
        "path/to/file/openskills-mcp/openskills.js"
      ]
    }
  }
}
```

