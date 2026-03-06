import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

const MAX_FILE_BYTES = 95 * 1024 * 1024;
const REPO_SAFE_LIMIT_BYTES = 750 * 1024 * 1024;
const GH_API = "https://api.github.com";
const ALLOWED_ORIGIN = process.env.FRONTEND_URLS || "http://localhost:3000";

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin === ALLOWED_ORIGIN) return callback(null, true);
    callback(new Error(`CORS: origin "${origin}" is not allowed`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));
app.use(express.json({ limit: "5mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } }).single("file");

function ghHeaders(token) {
    return {
        Authorization: `token ${token}`,           
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
    };
}

async function ghGet(path, token) {
    const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders(token) });
    const body = await res.json();

    if (!res.ok)
        throw { status: res.status, message: body.message || "GitHub API error" };

    return body;
}

async function ghPost(path, token, payload) {
    const res = await fetch(`${GH_API}${path}`, { method: "POST", headers: ghHeaders(token), body: JSON.stringify(payload) });
    const body = await res.json();
    if (!res.ok) throw { status: res.status, message: body.message || "GitHub API error" };

    return body;
}

async function ghPut(path, token, payload) {
    const res = await fetch(`${GH_API}${path}`, { method: "PUT", headers: ghHeaders(token), body: JSON.stringify(payload) });
    const body = await res.json();
    if (!res.ok) {
        throw { status: res.status, message: body.message || "Github API error" };
    }

    return body;
}

async function ghDelete(path, token, payload) {
    const res = await fetch(`${GH_API}${path}`, { method: "DELETE", headers: ghHeaders(token), body: JSON.stringify(payload) });
    const body = await res.json();
    if (!res.ok) {
        throw { status: res.status, message: body.message || "Github API error" };
    }

    return body;
}

function repoStats(r) {
    const diskBytes = (r.size || 0) * 1024;
    return {
        diskBytes,
        diskMB: (diskBytes / 1048576).toFixed(2),
        safeLimitMB: (REPO_SAFE_LIMIT_BYTES / 1048576).toFixed(0),
        percentUsed: Math.min((diskBytes / REPO_SAFE_LIMIT_BYTES) * 100, 100).toFixed(1),
        remainingMB: Math.max((REPO_SAFE_LIMIT_BYTES - diskBytes) / 1048576, 0).toFixed(1),
    };
}

function handleError(res, err) {
    console.error("[gitVault]", err.message || err);
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
}

app.get("/api/user", async (req, res) => {
    const { token } = req.query;
    if (!token)
        return res.status(400).json({ error: "token required" });

    try {
        const u = await ghGet("/user", token);
        res.json({ login: u.login, name: u.name || u.login, avatar: u.avatar_url, url: u.html_url });
    } catch (err) {
        handleError(res, err);
    }
});


app.get("/api/repos", async (req, res) => {
    const { token } = req.query;
    if (!token)
        return res.status(400).json({ error: "token required" });

    try {
        let all = [], page = 1;
        while (true) {
            const batch = await ghGet(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner`, token); // ✅ Fix 3: was sort=updates
            all = all.concat(batch);
            if (batch.length < 100)
                break;

            page++;
        }

        res.json({
            repos: all.map((r) => ({
                id: r.id, name: r.name, fullName: r.full_name, owner: r.owner.login,
                private: r.private, description: r.description || "",
                diskBytes: (r.size || 0) * 1024,
                diskMB: ((r.size || 0) / 1024).toFixed(2),
                percentUsed: Math.min(((r.size || 0) * 1024 / REPO_SAFE_LIMIT_BYTES) * 100, 100).toFixed(1),
                updatedAt: r.updated_at, url: r.html_url, defaultBranch: r.default_branch,
            })),
        });
    } catch (err) {
        handleError(res, err);
    }
});

app.post("/api/repos", async (req, res) => {
    const { token, name, description = "", isPrivate = true } = req.body;
    if (!token || !name)
        return res.status(400).json({ error: "Name and token required" });

    try {
        const repo = await ghPost("/user/repos", token, {
            name, description: description || "GitVault storage",
            private: isPrivate, auto_init: true,
        });

        res.json({ ok: true, name: repo.name, fullName: repo.full_name, owner: repo.owner.login, private: repo.private, url: repo.html_url, defaultBranch: repo.default_branch });

    } catch (err) {
        handleError(res, err);
    }
});

app.post("/api/connect", async (req, res) => {
  const { token, owner, repo } = req.body;
  if (!token || !owner || !repo) return res.status(400).json({ error: "token, owner, repo required" });
  try {
    const data = await ghGet(`/repos/${owner}/${repo}`, token);
    res.json({ ok: true, repoFullName: data.full_name, private: data.private, defaultBranch: data.default_branch, ...repoStats(data) });
  } catch (err) { handleError(res, err); }
});

app.get("/api/files", async (req, res) => {
  const { token, owner, repo, path = "files" } = req.query;
  if (!token || !owner || !repo) return res.status(400).json({ error: "token, owner, repo required" });
  try {
    let items;
    try { items = await ghGet(`/repos/${owner}/${repo}/contents/${path}`, token); }
    catch (err) { if (err.status === 404) return res.json({ items: [], path }); throw err; }
    const list = Array.isArray(items) ? items : [items];
    res.json({ path, items: list.map((i) => ({ name: i.name, path: i.path, type: i.type, size: i.size, sha: i.sha, downloadUrl: i.download_url, htmlUrl: i.html_url })) });
  } catch (err) { handleError(res, err); }
});

app.post("/api/upload", (req, res) => {
  upload(req, res, async (multerErr) => {
    if (multerErr) {
      if (multerErr.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File exceeds 95 MB limit." });
      return res.status(400).json({ error: multerErr.message });
    }
    const { token, owner, repo, path } = req.body;
    if (!token || !owner || !repo || !path) return res.status(400).json({ error: "token, owner, repo, path required" });
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const fileBytes = req.file.size;
    if (fileBytes > MAX_FILE_BYTES) return res.status(413).json({ error: `File too large: ${(fileBytes/1048576).toFixed(1)} MB (max 95 MB)` });
    try {
      const repoData = await ghGet(`/repos/${owner}/${repo}`, token);
      const currentDisk = (repoData.size || 0) * 1024;
      if (currentDisk + fileBytes > REPO_SAFE_LIMIT_BYTES)
        return res.status(507).json({ error: `Repo at ${(currentDisk/1048576).toFixed(0)} MB — upload would exceed 750 MB safe limit.` });
      let sha = null;
      try { const ex = await ghGet(`/repos/${owner}/${repo}/contents/${path}`, token); sha = ex.sha; } catch (_) {}
      const payload = { message: `Upload ${path}`, content: req.file.buffer.toString("base64") };
      if (sha) payload.sha = sha;
      const result = await ghPut(`/repos/${owner}/${repo}/contents/${path}`, token, payload);
      res.json({ ok: true, path: result.content?.path, sha: result.content?.sha, size: fileBytes, updated: !!sha });
    } catch (err) { handleError(res, err); }
  });
});

app.post("/api/folder", async (req, res) => {
  const { token, owner, repo, path } = req.body;
  if (!token || !owner || !repo || !path) return res.status(400).json({ error: "All fields required" });
  const keepPath = `${path}/.gitkeep`;
  try {
    let sha = null;
    try { const ex = await ghGet(`/repos/${owner}/${repo}/contents/${keepPath}`, token); sha = ex.sha; } catch (_) {}
    const payload = { message: `Create folder ${path}`, content: btoa("") };
    if (sha) payload.sha = sha;
    await ghPut(`/repos/${owner}/${repo}/contents/${keepPath}`, token, payload);
    res.json({ ok: true, path });
  } catch (err) { handleError(res, err); }
});

app.delete("/api/files", async (req, res) => {
  const { token, owner, repo, path, sha } = req.body;
  if (!token || !owner || !repo || !path || !sha) return res.status(400).json({ error: "All fields required" });
  try {
    await ghDelete(`/repos/${owner}/${repo}/contents/${path}`, token, { message: `Delete ${path}`, sha });
    res.json({ ok: true, path });
  } catch (err) { handleError(res, err); }
});

app.get("/api/stats", async (req, res) => {
  const { token, owner, repo } = req.query;
  if (!token || !owner || !repo) return res.status(400).json({ error: "token, owner, repo required" });
  try {
    const data = await ghGet(`/repos/${owner}/${repo}`, token);
    res.json(repoStats(data));
  } catch (err) { handleError(res, err); }
});

app.delete("/api/folder", async (req, res) => {
  const { token, owner, repo, path } = req.body;
  if (!token || !owner || !repo || !path) return res.status(400).json({ error: "All fields required" });
  async function collectFiles(dirPath) {
    let files = [];
    try {
      const items = await ghGet(`/repos/${owner}/${repo}/contents/${dirPath}`, token);
      const list = Array.isArray(items) ? items : [items];
      for (const item of list) {
        if (item.type === "file") {
          files.push({ path: item.path, sha: item.sha });
        } else if (item.type === "dir") {
          const nested = await collectFiles(item.path);
          files = files.concat(nested);
        }
      }
    } catch (e) {}
    return files;
  }

  try {
    const files = await collectFiles(path);
    if (files.length === 0) return res.json({ ok: true, deleted: 0 });

    for (const file of files) {
      await ghDelete(`/repos/${owner}/${repo}/contents/${file.path}`, token, {
        message: `Delete ${file.path}`,
        sha: file.sha,
      });
    }
    res.json({ ok: true, deleted: files.length });
  } catch (err) { handleError(res, err); }
});

app.delete("/api/repo", async (req, res) => {
  const { token, owner, repo } = req.body;
  if (!token || !owner || !repo) return res.status(400).json({ error: "All fields required" });
  try {
    const delRes = await fetch(`${GH_API}/repos/${owner}/${repo}`, {
      method: "DELETE",
      headers: ghHeaders(token),
    });
    if (delRes.status === 204) return res.json({ ok: true });
    const body = await delRes.json().catch(() => ({}));
    throw { status: delRes.status, message: body.message || "Failed to delete repository" };
  } catch (err) { handleError(res, err); }
});

app.get("/health", (_, res) => res.json({ ok: true, service: "FileVault API", version: "2.0.0" }));

app.listen(PORT, () => console.log(`\n🗄  GitVault API → http://localhost:${PORT}\n`));