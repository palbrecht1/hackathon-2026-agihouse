"""Curated real-world demo diffs from open-source projects for impressive demos."""

# These are real-world patterns found in popular OSS projects.
# Each demonstrates different types of issues the swarm can catch.

DAYTONA_SANDBOX_API = '''diff --git a/apps/api/src/sandbox/controllers/sandbox.controller.ts b/apps/api/src/sandbox/controllers/sandbox.controller.ts
--- a/apps/api/src/sandbox/controllers/sandbox.controller.ts
+++ b/apps/api/src/sandbox/controllers/sandbox.controller.ts
@@ -45,6 +45,58 @@ export class SandboxController {
   constructor(
     private readonly sandboxService: SandboxService,
     private readonly snapshotService: SnapshotService,
+    private readonly logger: Logger,
   ) {}

+  @Post('/:sandboxId/exec')
+  async executeCommand(
+    @Param('sandboxId') sandboxId: string,
+    @Body() body: { command: string; timeout?: number },
+    @AuthContext() authContext: AuthContext,
+  ) {
+    const sandbox = await this.sandboxService.findOne(sandboxId)
+    if (!sandbox) {
+      throw new NotFoundError('Sandbox not found')
+    }
+
+    // Execute the command in the sandbox
+    const result = await this.sandboxService.exec(
+      sandbox,
+      body.command,
+      body.timeout || 30000,
+    )
+
+    this.logger.info(`Command executed in sandbox ${sandboxId}: ${body.command}`)
+    return { output: result.stdout, exitCode: result.exitCode }
+  }
+
+  @Post('/batch-create')
+  async batchCreate(
+    @Body() body: { count: number; snapshot: string; labels?: Record<string, string> },
+    @AuthContext() authContext: AuthContext,
+  ) {
+    const sandboxes = []
+    for (let i = 0; i < body.count; i++) {
+      const sandbox = await this.sandboxService.create({
+        organizationId: authContext.organizationId,
+        snapshot: body.snapshot,
+        labels: body.labels,
+      })
+      sandboxes.push(sandbox)
+    }
+    return { sandboxes }
+  }
+
+  @Get('/export')
+  async exportData(
+    @Query('format') format: string,
+    @Query('path') filePath: string,
+    @AuthContext() authContext: AuthContext,
+  ) {
+    const data = await this.sandboxService.readFile(filePath)
+    const fileName = filePath.split('/').pop()
+    return { data: data.toString('base64'), fileName, format }
+  }
+
   @Get('/')
   async list(
     @Query() queryParams: ListSandboxesQuery,
'''

DAYTONA_SDK_AUTH = '''diff --git a/libs/sdk-go/pkg/daytona/client.go b/libs/sdk-go/pkg/daytona/client.go
--- a/libs/sdk-go/pkg/daytona/client.go
+++ b/libs/sdk-go/pkg/daytona/client.go
@@ -12,6 +12,7 @@ import (
 	"net/http"
 	"os"
 	"sync"
+	"time"
 )

 type Client struct {
@@ -19,6 +20,7 @@ type Client struct {
 	apiKey    string
 	baseURL   string
 	httpClient *http.Client
+	tokenCache map[string]cachedToken
+	cacheMu    sync.Mutex
 }

+type cachedToken struct {
+	token     string
+	expiresAt time.Time
+}
+
 func NewClient() (*Client, error) {
 	apiKey := os.Getenv("DAYTONA_API_KEY")
 	baseURL := os.Getenv("DAYTONA_API_URL")
@@ -35,6 +43,7 @@ func NewClient() (*Client, error) {
 		apiKey:     apiKey,
 		baseURL:    baseURL,
 		httpClient: &http.Client{Timeout: 30 * time.Second},
+		tokenCache: make(map[string]cachedToken),
 	}, nil
 }

@@ -42,15 +51,40 @@ func (c *Client) Do(ctx context.Context, method, path string, body interface{})
 	url := fmt.Sprintf("%s%s", c.baseURL, path)

 	var reqBody io.Reader
 	if body != nil {
-		jsonBytes, err := json.Marshal(body)
-		if err != nil {
-			return nil, fmt.Errorf("failed to marshal request body: %w", err)
-		}
+		jsonBytes, _ := json.Marshal(body)
 		reqBody = bytes.NewReader(jsonBytes)
 	}

 	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
 	if err != nil {
 		return nil, err
 	}
-	req.Header.Set("Authorization", "Bearer "+c.apiKey)
+	token, err := c.getToken(ctx)
+	if err != nil {
+		return nil, fmt.Errorf("auth failed: %w", err)
+	}
+	req.Header.Set("Authorization", "Bearer "+token)
 	req.Header.Set("Content-Type", "application/json")

 	resp, err := c.httpClient.Do(req)
 	if err != nil {
 		return nil, err
 	}
+	defer resp.Body.Close()

 	return resp, nil
 }

+func (c *Client) getToken(ctx context.Context) (string, error) {
+	c.cacheMu.Lock()
+	if cached, ok := c.tokenCache[c.apiKey]; ok && time.Now().Before(cached.expiresAt) {
+		c.cacheMu.Unlock()
+		return cached.token, nil
+	}
+	c.cacheMu.Unlock()
+
+	// Exchange API key for short-lived token
+	tokenURL := fmt.Sprintf("%s/auth/token", c.baseURL)
+	req, _ := http.NewRequestWithContext(ctx, "POST", tokenURL, nil)
+	req.Header.Set("X-API-Key", c.apiKey)
+
+	resp, err := c.httpClient.Do(req)
+	if err != nil {
+		return "", err
+	}
+	var tokenResp struct {
+		Token     string `json:"token"`
+		ExpiresIn int    `json:"expires_in"`
+	}
+	json.NewDecoder(resp.Body).Decode(&tokenResp)
+
+	c.cacheMu.Lock()
+	c.tokenCache[c.apiKey] = cachedToken{
+		token:     tokenResp.Token,
+		expiresAt: time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second),
+	}
+	c.cacheMu.Unlock()
+
+	return tokenResp.Token, nil
+}
'''

DAYTONA_WORKSPACE_MANAGER = '''diff --git a/apps/api/src/workspace/workspace.service.ts b/apps/api/src/workspace/workspace.service.ts
--- a/apps/api/src/workspace/workspace.service.ts
+++ b/apps/api/src/workspace/workspace.service.ts
@@ -1,8 +1,11 @@
-import { Injectable } from '@nestjs/common'
+import { Injectable, Logger } from '@nestjs/common'
 import { InjectRepository } from '@nestjs/typeorm'
 import { Repository } from 'typeorm'
 import { Workspace } from './workspace.entity'
+import { exec } from 'child_process'
+import { promisify } from 'util'
+
+const execAsync = promisify(exec)

 @Injectable()
 export class WorkspaceService {
+  private readonly logger = new Logger(WorkspaceService.name)
+
   constructor(
     @InjectRepository(Workspace)
     private workspaceRepo: Repository<Workspace>,
   ) {}

+  async cloneRepository(workspace: Workspace, gitUrl: string, branch?: string) {
+    const targetDir = `/workspaces/${workspace.id}/${gitUrl.split('/').pop()?.replace('.git', '')}`
+    const cmd = branch
+      ? `git clone -b ${branch} ${gitUrl} ${targetDir}`
+      : `git clone ${gitUrl} ${targetDir}`
+
+    const { stdout, stderr } = await execAsync(cmd)
+    this.logger.log(`Cloned ${gitUrl} to ${targetDir}`)
+
+    return { path: targetDir, stdout, stderr }
+  }
+
+  async installDependencies(workspace: Workspace, packageManager: string) {
+    const workDir = `/workspaces/${workspace.id}`
+    const commands: Record<string, string> = {
+      npm: 'npm install',
+      yarn: 'yarn install',
+      pnpm: 'pnpm install',
+      pip: 'pip install -r requirements.txt',
+    }
+
+    const cmd = commands[packageManager]
+    if (!cmd) {
+      throw new Error(`Unsupported package manager: ${packageManager}`)
+    }
+
+    const { stdout } = await execAsync(cmd, { cwd: workDir })
+    return { output: stdout }
+  }
+
   async findAll(organizationId: string): Promise<Workspace[]> {
-    return this.workspaceRepo.find({ where: { organizationId } })
+    const query = `SELECT * FROM workspaces WHERE organization_id = '${organizationId}'`
+    return this.workspaceRepo.query(query)
   }

+  async findByLabel(organizationId: string, label: string): Promise<Workspace[]> {
+    return this.workspaceRepo.find({
+      where: { organizationId, labels: { [label]: true } },
+    })
+  }
+
+  async deleteWorkspace(workspace: Workspace) {
+    // Clean up workspace files
+    await execAsync(`rm -rf /workspaces/${workspace.id}`)
+    await this.workspaceRepo.delete(workspace.id)
+    this.logger.log(`Deleted workspace ${workspace.id}`)
+  }
+
+  async getWorkspaceStats(organizationId: string) {
+    const workspaces = await this.findAll(organizationId)
+    const stats = {
+      total: workspaces.length,
+      byState: {} as Record<string, number>,
+      totalMemoryMB: 0,
+    }
+
+    for (const ws of workspaces) {
+      stats.byState[ws.state] = (stats.byState[ws.state] || 0) + 1
+      const { stdout } = await execAsync(
+        `du -sm /workspaces/${ws.id} 2>/dev/null | cut -f1`
+      )
+      stats.totalMemoryMB += parseInt(stdout.trim()) || 0
+    }
+
+    return stats
+  }
 }
'''

# Map of demo names to their diffs and descriptions
DEMO_DIFFS = {
    "daytona-sandbox-api": {
        "diff": DAYTONA_SANDBOX_API,
        "description": "Daytona Sandbox API — new exec, batch-create, and export endpoints",
        "source": "daytonaio/daytona (sandbox controller)",
    },
    "daytona-sdk-auth": {
        "diff": DAYTONA_SDK_AUTH,
        "description": "Daytona Go SDK — token caching and auth refactor",
        "source": "daytonaio/daytona (Go SDK client)",
    },
    "daytona-workspace": {
        "diff": DAYTONA_WORKSPACE_MANAGER,
        "description": "Daytona Workspace Service — clone, install deps, stats, and cleanup",
        "source": "daytonaio/daytona (workspace manager)",
    },
}

# The "killer" demo diff — most impressive for a live presentation
# It has: SQL injection, command injection, path traversal, N+1, race condition potential
KILLER_DEMO = DAYTONA_WORKSPACE_MANAGER
KILLER_DEMO_NAME = "daytona-workspace"
