/**
 * Kodbox/可道云 API 客户端
 * 实现文件上传、下载、分享、权限管理、目录操作等核心功能
 */

export interface KodboxConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export interface KodboxAuthResponse {
  // Kodbox 不同版本/端点成功码可能为 0 或 true；token 可能位于 info 或 data.token。
  code: number | boolean;
  message: string;
  info?: string;
  data?: {
    user: {
      uid: number;
      username: string;
      role: string;
      role_name: string;
    };
    token: string;
  };
}

export interface KodboxFileInfo {
  fid: string;
  name: string;
  path: string;
  size: number;
  mtime: number;
  type: "file" | "dir";
  ext?: string;
  is_dir: boolean;
}

export interface KodboxListResponse {
  code: number;
  message: string;
  data: {
    list: KodboxFileInfo[];
    total: number;
    path: string;
  };
}

export interface KodboxUploadResponse {
  code: number;
  message: string;
  data?: {
    fid: string;
    name: string;
    path: string;
    size: number;
  };
}

export interface KodboxShareResponse {
  code: number;
  message: string;
  data?: {
    share_id: string;
    share_url: string;
    password?: string;
    expire_time?: number;
  };
}

export interface KodboxPermission {
  path: string;
  user_id: string;
  permission: "read" | "write" | "read_write" | "admin";
}

export interface KodboxUser {
  uid: number;
  username: string;
  role: string;
  role_name: string;
  email?: string;
  home_path?: string;
}

export interface KodboxUserListResponse {
  code: number;
  message: string;
  data: {
    list: KodboxUser[];
    total: number;
  };
}

export class KodboxClient {
  private config: Required<KodboxConfig>;
  private token: string | null = null;
  private csrfToken: string | null = null;
  private cookieJar: Map<string, string> = new Map();

  constructor(config: KodboxConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      username: config.username,
      password: config.password,
      timeoutMs: config.timeoutMs ?? 30000,
    };
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    formData?: FormData
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: HeadersInit = {
      ...options.headers,
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (this.csrfToken) {
      headers["X-CSRF-Token"] = this.csrfToken;
    }

    const cookieHeader = Array.from(this.cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        body: formData ?? options.body,
        signal: controller.signal,
      });

      // 更新 cookie
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const cookies = setCookie.split(", ").map((c) => c.split(";")[0]);
        for (const cookie of cookies) {
          const [key, value] = cookie.split("=");
          if (key && value) {
            this.cookieJar.set(key.trim(), value.trim());
            if (key.trim() === "CSRF_TOKEN") {
              this.csrfToken = value.trim();
            }
          }
        }
      }

      if (!response.ok) {
        throw new Error(`Kodbox API error: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 登录获取 token
   */
  async login(): Promise<KodboxAuthResponse> {
    const formData = new FormData();
    formData.append("name", this.config.username);
    formData.append("password", this.config.password);

    const response = await this.request<KodboxAuthResponse>("/index.php?user/index/loginSubmit", {
      method: "POST",
    }, formData);

    if (response.code === 0 || response.code === true) {
      this.token = response.info ?? response.data?.token ?? "";
      if (!this.token) throw new Error(`Kodbox login failed: ${response.message}`);
    } else {
      throw new Error(`Kodbox login failed: ${response.message}`);
    }

    return response;
  }

  /**
   * 确保已登录
   */
  private async ensureAuth(): Promise<void> {
    if (!this.token) {
      await this.login();
    }
  }

  /**
   * 列出目录内容
   */
  async list(path: string = "/"): Promise<KodboxListResponse> {
    await this.ensureAuth();
    return this.request<KodboxListResponse>(
      `/index.php?explorer/list&path=${encodeURIComponent(path)}`,
      { method: "GET" }
    );
  }

  /**
   * 创建目录
   */
  async mkdir(path: string, name: string): Promise<KodboxUploadResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("path", path);
    formData.append("name", name);
    return this.request<KodboxUploadResponse>("/index.php?explorer/newFolder", {
      method: "POST",
    }, formData);
  }

  /**
   * 上传文件
   */
  async upload(
    path: string,
    file: Blob,
    filename: string,
    onProgress?: (progress: number) => void
  ): Promise<KodboxUploadResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("path", path);
    formData.append("file", file, filename);

    // 简单的进度模拟（fetch 不直接支持上传进度，实际可用 XMLHttpRequest）
    if (onProgress) {
      onProgress(0);
      setTimeout(() => onProgress(50), 100);
    }

    const response = await this.request<KodboxUploadResponse>(
      "/index.php?explorer/upload",
      { method: "POST" },
      formData
    );

    if (onProgress) onProgress(100);
    return response;
  }

  /**
   * 下载文件
   */
  async download(path: string): Promise<Blob> {
    await this.ensureAuth();
    const url = `${this.config.baseUrl}/index.php?explorer/download&path=${encodeURIComponent(path)}`;
    const headers: HeadersInit = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const cookieHeader = Array.from(this.cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return response.blob();
  }

  /**
   * 删除文件/目录
   */
  async delete(paths: string[]): Promise<KodboxUploadResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("paths", JSON.stringify(paths));
    return this.request<KodboxUploadResponse>("/index.php?explorer/delete", {
      method: "POST",
    }, formData);
  }

  /**
   * 移动/重命名
   */
  async move(sourcePath: string, destPath: string, newName?: string): Promise<KodboxUploadResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("source", sourcePath);
    formData.append("dest", destPath);
    if (newName) formData.append("newName", newName);
    return this.request<KodboxUploadResponse>("/index.php?explorer/copy", {
      method: "POST",
    }, formData);
  }

  /**
   * 创建分享链接
   */
  async createShare(
    path: string,
    options: {
      password?: string;
      expireDays?: number;
      permission?: "read" | "write" | "read_write";
    } = {}
  ): Promise<KodboxShareResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("path", path);
    if (options.password) formData.append("password", options.password);
    if (options.expireDays) formData.append("expire", String(options.expireDays * 86400));
    if (options.permission) formData.append("permission", options.permission);
    return this.request<KodboxShareResponse>("/index.php?share/create", {
      method: "POST",
    }, formData);
  }

  /**
   * 取消分享
   */
  async revokeShare(shareId: string): Promise<KodboxUploadResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("share_id", shareId);
    return this.request<KodboxUploadResponse>("/index.php?share/cancel", {
      method: "POST",
    }, formData);
  }

  /**
   * 获取用户列表
   */
  async listUsers(): Promise<KodboxUserListResponse> {
    await this.ensureAuth();
    return this.request<KodboxUserListResponse>("/index.php?user/list", {
      method: "GET",
    });
  }

  /**
   * 创建用户
   */
  async createUser(
    username: string,
    password: string,
    role: "admin" | "user" = "user",
    homePath?: string
  ): Promise<KodboxUploadResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("username", username);
    formData.append("password", password);
    formData.append("role", role);
    if (homePath) formData.append("home", homePath);
    return this.request<KodboxUploadResponse>("/index.php?user/add", {
      method: "POST",
    }, formData);
  }

  /**
   * 设置目录权限
   * 可道云通过用户主目录和组权限管理，这里封装为路径级权限
   */
  async setPathPermission(
    path: string,
    userId: string,
    permission: "read" | "write" | "read_write" | "admin"
  ): Promise<KodboxUploadResponse> {
    await this.ensureAuth();
    const formData = new FormData();
    formData.append("path", path);
    formData.append("user_id", userId);
    formData.append("permission", permission);
    return this.request<KodboxUploadResponse>("/index.php?acl/set", {
      method: "POST",
    }, formData);
  }

  /**
   * 获取目录权限列表
   */
  async getPathPermissions(path: string): Promise<{
    code: number;
    message: string;
    data: KodboxPermission[];
  }> {
    await this.ensureAuth();
    return this.request(`/index.php?acl/list&path=${encodeURIComponent(path)}`, {
      method: "GET",
    });
  }

  /**
   * 获取文件/目录详细信息
   */
  async stat(path: string): Promise<KodboxFileInfo | null> {
    const response = await this.list(path);
    if (response.code === 0 && response.data.list.length > 0) {
      return response.data.list[0];
    }
    return null;
  }

  /**
   * 检查路径是否存在
   */
  async exists(path: string): Promise<boolean> {
    const info = await this.stat(path);
    return info !== null;
  }
}

/**
 * 创建 Kodbox 客户端实例（单例模式）
 */
let kodboxInstance: KodboxClient | null = null;

export function createKodboxClient(config: KodboxConfig): KodboxClient {
  return new KodboxClient(config);
}

export function getKodboxClient(config?: KodboxConfig): KodboxClient {
  if (!kodboxInstance && config) {
    kodboxInstance = new KodboxClient(config);
  }
  if (!kodboxInstance) {
    throw new Error("Kodbox client not initialized. Call createKodboxClient first.");
  }
  return kodboxInstance;
}

export function resetKodboxClient(): void {
  kodboxInstance = null;
}