#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as process from "process";
import { z } from "zod";
import { docs_v1, drive_v3 } from "googleapis";

// Handle command line arguments
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf-8'));
  console.log(`docugen-mcp v${packageJson.version}`);
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
DocuGen MCP Server - Simple Google Docs automation

Usage:
  npx docugen-mcp              Start the MCP server
  npx docugen-mcp --version    Show version
  npx docugen-mcp --help       Show this help

Tools:
  CreateDoc - Create a new Google Doc
  UpdateDoc - Update existing document content
  DeleteDoc - Delete a document
  FormatDoc - Apply formatting to document text
`);
  process.exit(0);
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive"
];

const USER_HOME = os.homedir();
const DOCUGEN_DIR = path.join(USER_HOME, '.docugen');
const TOKEN_PATH = process.env.TOKEN_PATH || path.join(DOCUGEN_DIR, "token.json");

// Ensure directory exists
if (!fs.existsSync(DOCUGEN_DIR)) {
  fs.mkdirSync(DOCUGEN_DIR, { recursive: true });
}

// Create MCP server instance
const server = new McpServer({
  name: "docgen",
  version: "2.0.0",
});

// ============================================================================
// GOOGLE API SETUP
// ============================================================================

let docsClient: docs_v1.Docs;
let driveClient: drive_v3.Drive;

async function authorize(): Promise<any> {
  // Load saved token if exists
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        "urn:ietf:wg:oauth:2.0:oob"
      );
      oauth2Client.setCredentials(token);
      return oauth2Client;
    } catch (error) {
      console.error("Invalid token, re-authenticating...");
    }
  }
  
  // Get credentials path
  const credentialsPath = process.env.GOOGLE_OAUTH_PATH || 
                          path.join(process.cwd(), 'credentials.json');
  
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Credentials file not found at ${credentialsPath}`);
  }
  
  // Authenticate
  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: credentialsPath,
  });
  
  // Save token
  const token = auth.credentials;
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
  
  return auth;
}

async function initClients(): Promise<boolean> {
  try {
    const auth = await authorize();
    docsClient = google.docs({ version: "v1", auth });
    driveClient = google.drive({ version: "v3", auth });
    return true;
  } catch (error) {
    console.error("Failed to initialize Google API clients:", error);
    return false;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Format markdown table as monospace text
function formatMarkdownTable(text: string): string {
  // Find markdown tables and add monospace formatting
  const lines = text.split('\n');
  const formattedLines: string[] = [];
  let inTable = false;
  
  for (const line of lines) {
    if (line.includes('|')) {
      // This looks like a table row
      if (!inTable) {
        inTable = true;
        formattedLines.push('```'); // Start monospace block
      }
      formattedLines.push(line);
    } else if (inTable) {
      // End of table
      inTable = false;
      formattedLines.push('```'); // End monospace block
      formattedLines.push(line);
    } else {
      formattedLines.push(line);
    }
  }
  
  // Close table if still open
  if (inTable) {
    formattedLines.push('```');
  }
  
  return formattedLines.join('\n');
}

// ============================================================================
// SIMPLE MCP TOOLS
// ============================================================================

// 1. CreateDoc - Create a new document with content (supports markdown tables as text)
server.tool(
  "CreateDoc",
  {
    title: z.string().describe("Document title"),
    content: z.string().optional().describe("Initial content - plain text or markdown (tables rendered as text)")
  },
  async ({ title, content }) => {
    try {
      if (!docsClient) {
        return {
          content: [{
            type: "text",
            text: "❌ Google API not initialized. Please check credentials."
          }],
          isError: true
        };
      }
      
      // Create document
      const createResponse = await docsClient.documents.create({
        requestBody: { title }
      });
      
      const documentId = createResponse.data.documentId!;
      
      // Add content if provided
      if (content) {
        // Format markdown tables as monospace text
        const formattedContent = formatMarkdownTable(content);
        
        const requests = [{
          insertText: {
            location: { index: 1 },
            text: formattedContent
          }
        }];
        
        await docsClient.documents.batchUpdate({
          documentId,
          requestBody: { requests }
        });
      }
      
      return {
        content: [{
          type: "text",
          text: `✅ Created document "${title}"\nID: ${documentId}`
        }]
      };
      
    } catch (error) {
      console.error("Error creating document:", error);
      return {
        content: [{
          type: "text",
          text: `Error: ${error}`
        }],
        isError: true
      };
    }
  }
);

// 2. UpdateDoc - Update document content
server.tool(
  "UpdateDoc",
  {
    documentId: z.string().describe("Document ID"),
    content: z.string().describe("New content to add or replace"),
    mode: z.enum(["replace", "append"]).optional().describe("Update mode (default: append)")
  },
  async ({ documentId, content, mode = "append" }) => {
    try {
      if (!docsClient) {
        return {
          content: [{
            type: "text",
            text: "❌ Google API not initialized."
          }],
          isError: true
        };
      }
      
      const requests: any[] = [];
      
      if (mode === "replace") {
        // Get document to find content length
        const doc = await docsClient.documents.get({ documentId });
        const endIndex = doc.data.body?.content?.slice(-1)[0]?.endIndex || 1;
        
        // Clear existing content
        if (endIndex > 1) {
          requests.push({
            deleteContentRange: {
              range: {
                startIndex: 1,
                endIndex: endIndex - 1
              }
            }
          });
        }
        
        // Add new content
        requests.push({
          insertText: {
            location: { index: 1 },
            text: content
          }
        });
      } else {
        // Append mode - add to the end
        const doc = await docsClient.documents.get({ documentId });
        const endIndex = doc.data.body?.content?.slice(-1)[0]?.endIndex || 1;
        
        requests.push({
          insertText: {
            location: { index: endIndex - 1 },
            text: "\n" + content
          }
        });
      }
      
      await docsClient.documents.batchUpdate({
        documentId,
        requestBody: { requests }
      });
      
      return {
        content: [{
          type: "text",
          text: `✅ Updated document ${documentId} (mode: ${mode})`
        }]
      };
      
    } catch (error) {
      console.error("Error updating document:", error);
      return {
        content: [{
          type: "text",
          text: `Error: ${error}`
        }],
        isError: true
      };
    }
  }
);

// 3. DeleteDoc - Delete a document
server.tool(
  "DeleteDoc",
  {
    documentId: z.string().describe("Document ID to delete")
  },
  async ({ documentId }) => {
    try {
      if (!driveClient) {
        return {
          content: [{
            type: "text",
            text: "❌ Google API not initialized."
          }],
          isError: true
        };
      }
      
      await driveClient.files.delete({
        fileId: documentId
      });
      
      return {
        content: [{
          type: "text",
          text: `✅ Deleted document ${documentId}`
        }]
      };
      
    } catch (error) {
      console.error("Error deleting document:", error);
      return {
        content: [{
          type: "text",
          text: `Error: ${error}`
        }],
        isError: true
      };
    }
  }
);

// 4. FormatDoc - Apply simple formatting
server.tool(
  "FormatDoc",
  {
    documentId: z.string().describe("Document ID"),
    formatting: z.array(z.object({
      text: z.string().describe("Text to format"),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      heading: z.number().min(1).max(3).optional().describe("Heading level (1-3)")
    })).describe("Formatting instructions")
  },
  async ({ documentId, formatting }) => {
    try {
      if (!docsClient) {
        return {
          content: [{
            type: "text",
            text: "❌ Google API not initialized."
          }],
          isError: true
        };
      }
      
      // Get document content
      const doc = await docsClient.documents.get({ documentId });
      const requests: any[] = [];
      
      // Find and format each text
      for (const format of formatting) {
        // Search for text in document
        let textContent = "";
        let occurrences: Array<{start: number, end: number}> = [];
        
        if (doc.data.body?.content) {
          doc.data.body.content.forEach((element: any) => {
            if (element.paragraph?.elements) {
              element.paragraph.elements.forEach((elem: any) => {
                if (elem.textRun?.content) {
                  const text = elem.textRun.content;
                  let index = text.indexOf(format.text);
                  while (index !== -1) {
                    occurrences.push({
                      start: (elem.startIndex || 0) + index,
                      end: (elem.startIndex || 0) + index + format.text.length
                    });
                    index = text.indexOf(format.text, index + 1);
                  }
                }
              });
            }
          });
        }
        
        // Apply formatting to each occurrence
        for (const occurrence of occurrences) {
          // Text style
          const textStyle: any = {};
          const fields: string[] = [];
          
          if (format.bold !== undefined) {
            textStyle.bold = format.bold;
            fields.push('bold');
          }
          if (format.italic !== undefined) {
            textStyle.italic = format.italic;
            fields.push('italic');
          }
          if (format.underline !== undefined) {
            textStyle.underline = format.underline;
            fields.push('underline');
          }
          
          if (fields.length > 0) {
            requests.push({
              updateTextStyle: {
                range: {
                  startIndex: occurrence.start,
                  endIndex: occurrence.end
                },
                textStyle,
                fields: fields.join(',')
              }
            });
          }
          
          // Heading style
          if (format.heading) {
            const headingType = format.heading === 1 ? 'HEADING_1' :
                              format.heading === 2 ? 'HEADING_2' : 'HEADING_3';
            
            requests.push({
              updateParagraphStyle: {
                range: {
                  startIndex: occurrence.start,
                  endIndex: occurrence.end
                },
                paragraphStyle: {
                  namedStyleType: headingType
                },
                fields: 'namedStyleType'
              }
            });
          }
        }
      }
      
      if (requests.length > 0) {
        await docsClient.documents.batchUpdate({
          documentId,
          requestBody: { requests }
        });
      }
      
      return {
        content: [{
          type: "text",
          text: `✅ Applied formatting to document ${documentId}`
        }]
      };
      
    } catch (error) {
      console.error("Error formatting document:", error);
      return {
        content: [{
          type: "text",
          text: `Error: ${error}`
        }],
        isError: true
      };
    }
  }
);

// 5. ConvertToTable - Convert markdown table text to real Google Docs table
server.tool(
  "ConvertToTable",
  {
    documentId: z.string().describe("Document ID"),
    tableText: z.string().describe("Markdown table text to convert (with | separators)")
  },
  async ({ documentId, tableText }) => {
    try {
      if (!docsClient) {
        return {
          content: [{
            type: "text",
            text: "❌ Google API not initialized."
          }],
          isError: true
        };
      }
      
      // Parse markdown table
      const lines = tableText.trim().split('\n');
      const rows: string[][] = [];
      
      for (const line of lines) {
        // Skip separator lines (---|---|---)
        if (line.match(/^\|?[\s\-:|]+\|/)) continue;
        
        // Parse cells
        const cells = line
          .split('|')
          .map(cell => cell.trim())
          .filter(cell => cell !== '');
        
        if (cells.length > 0) {
          rows.push(cells);
        }
      }
      
      if (rows.length === 0) {
        return {
          content: [{
            type: "text",
            text: "❌ No valid table data found"
          }],
          isError: true
        };
      }
      
      // Get document to find where to insert table
      const doc = await docsClient.documents.get({ documentId });
      
      // Find the table text in document
      let tableStartIndex = -1;
      let tableEndIndex = -1;
      
      if (doc.data.body?.content) {
        let currentText = "";
        doc.data.body.content.forEach((element: any) => {
          if (element.paragraph?.elements) {
            element.paragraph.elements.forEach((elem: any) => {
              if (elem.textRun?.content) {
                const text = elem.textRun.content;
                const index = text.indexOf(lines[0]);
                if (index !== -1 && tableStartIndex === -1) {
                  tableStartIndex = (elem.startIndex || 0) + index;
                  // Find end of table
                  const lastLine = lines[lines.length - 1];
                  const endIndex = text.indexOf(lastLine);
                  if (endIndex !== -1) {
                    tableEndIndex = (elem.startIndex || 0) + endIndex + lastLine.length;
                  }
                }
              }
            });
          }
        });
      }
      
      if (tableStartIndex === -1) {
        return {
          content: [{
            type: "text",
            text: "❌ Could not find table text in document"
          }],
          isError: true
        };
      }
      
      // Build requests: delete text, insert table
      const requests: any[] = [];
      
      // Delete the markdown table text
      if (tableEndIndex > tableStartIndex) {
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: tableStartIndex,
              endIndex: tableEndIndex
            }
          }
        });
      }
      
      // Insert real table
      requests.push({
        insertTable: {
          rows: rows.length,
          columns: rows[0].length,
          location: { index: tableStartIndex }
        }
      });
      
      // Apply requests
      await docsClient.documents.batchUpdate({
        documentId,
        requestBody: { requests }
      });
      
      // Now populate the table cells
      const cellRequests: any[] = [];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        for (let colIndex = 0; colIndex < rows[rowIndex].length; colIndex++) {
          const cellText = rows[rowIndex][colIndex];
          if (cellText) {
            // Simple formula for cell index (may need adjustment)
            const cellIndex = tableStartIndex + 4 + (rowIndex * 5) + (colIndex * 2);
            cellRequests.push({
              insertText: {
                location: { index: cellIndex },
                text: cellText
              }
            });
          }
        }
      }
      
      if (cellRequests.length > 0) {
        await docsClient.documents.batchUpdate({
          documentId,
          requestBody: { requests: cellRequests }
        });
      }
      
      return {
        content: [{
          type: "text",
          text: `✅ Converted markdown table to Google Docs table (${rows.length} rows × ${rows[0].length} columns)`
        }]
      };
      
    } catch (error) {
      console.error("Error converting table:", error);
      return {
        content: [{
          type: "text",
          text: `Error: ${error}`
        }],
        isError: true
      };
    }
  }
);

// ============================================================================
// LIST DOCUMENTS (Resource)
// ============================================================================

server.resource(
  "ListDocs",
  "googledocs://list",
  async (uri) => {
    try {
      if (!driveClient) {
        return {
          contents: [{
            uri: uri.href,
            text: "❌ Google API not initialized."
          }]
        };
      }
      
      const response = await driveClient.files.list({
        q: "mimeType='application/vnd.google-apps.document'",
        fields: "files(id, name, createdTime, modifiedTime)",
        pageSize: 20,
        orderBy: "modifiedTime desc"
      });

      const files = response.data.files || [];
      let content = "Recent Google Docs:\n\n";
      
      if (files.length === 0) {
        content += "No documents found.";
      } else {
        files.forEach((file: any) => {
          content += `📄 ${file.name}\n`;
          content += `   ID: ${file.id}\n`;
          content += `   Modified: ${new Date(file.modifiedTime).toLocaleDateString()}\n\n`;
        });
      }

      return {
        contents: [{
          uri: uri.href,
          text: content,
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: uri.href,
          text: `Error: ${error}`,
        }]
      };
    }
  }
);

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const initialized = await initClients();
  
  if (!initialized) {
    console.error("⚠️  Failed to initialize Google API clients!");
    console.error("The server will run but operations will fail.");
  }
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DocGen MCP Server (Simplified) running");
  console.error("Tools: CreateDoc, UpdateDoc, DeleteDoc, FormatDoc");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});