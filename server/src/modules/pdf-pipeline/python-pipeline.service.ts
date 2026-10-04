import { BadGatewayException, GatewayTimeoutException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 超时上限：PRD 验收口径为全链路 ≤3 分钟，留出余量定为 150 秒
const PIPELINE_TIMEOUT_MS = 150_000;

// 单次进程执行结果
interface ProcResult {
    code: number
    stderrTail: string
    timedOut: boolean
}

@Injectable()
export class PythonPipelineService {
    private readonly logger = new Logger(PythonPipelineService.name);
    private pythonOk: boolean | null = null;

    constructor(private readonly config: ConfigService) {}

    // skill 根目录：优先环境变量 TENDER_SKILL_DIR，缺省 ~/.workbuddy/skills/tender-material-checklist
    private get skillDir(): string {
        return this.config.get<string>("TENDER_SKILL_DIR")
            ?? path.join(os.homedir(), ".workbuddy", "skills", "tender-material-checklist");
    }

    // Python 环境探测（结果缓存）；失败抛 503
    private async ensurePython(): Promise<void> {
        if (this.pythonOk === true) return
        try {
            await this.runOnce("python", ["--version"], 10_000);
            this.pythonOk = true;
        } catch {
            this.pythonOk = false;
            throw new ServiceUnavailableException(
                "未检测到 Python 环境：请安装 Python 3.11+ 并执行 pip install pdfplumber",
            );
        }
    }

    // 前置校验：Python 环境 + 管线脚本与 vendor 资源在位
    async precheck(): Promise<void> {
        await this.ensurePython();
        const script = path.join(this.skillDir, "scripts", "build_review_html.py");
        const vendor = path.join(this.skillDir, "assets", "vendor");
        if (!fs.existsSync(script)) {
            throw new ServiceUnavailableException(`管线脚本缺失：${script}（可用 TENDER_SKILL_DIR 指定 skill 目录）`);
        }
        if (!fs.existsSync(vendor)) {
            throw new ServiceUnavailableException(`pdf.js 渲染资源缺失：${vendor}`);
        }
    }

    // 提取 PDF 纯文本（供对话附件入库），返回 UTF-8 文本
    async extractText(pdfPath: string, outPath: string): Promise<string> {
        await this.runExtractScript(pdfPath, outPath, false);
        return fs.promises.readFile(outPath, "utf-8");
    }

    // 提取 PDF 分页文本（标书分块提取用）
    async extractPages(pdfPath: string, outPath: string): Promise<{ pageCount: number; pages: { pno: number; text: string }[] }> {
        await this.runExtractScript(pdfPath, outPath, true);
        const raw = await fs.promises.readFile(outPath, "utf-8");
        return JSON.parse(raw);
    }

    // 调用 extract_text.py；json=true 时输出分页 JSON 结构，否则输出纯文本
    private async runExtractScript(pdfPath: string, outPath: string, json: boolean): Promise<void> {
        await this.ensurePython();
        const script = path.join(this.skillDir, "scripts", "extract_text.py");
        if (!fs.existsSync(script)) {
            throw new ServiceUnavailableException(`PDF 提取脚本缺失：${script}`);
        }
        const args = [script, "--pdf", pdfPath, "--out", outPath];
        if (json) args.push("--json");
        this.logger.log("spawn: python " + args.join(" "));
        const started = Date.now();
        const result = await this.runOnce("python", args, PIPELINE_TIMEOUT_MS, true);
        this.logger.log(`提取退出码 ${result.code}，耗时 ${Date.now() - started}ms`);

        if (result.timedOut) {
            throw new GatewayTimeoutException(`PDF 文本提取超过 ${PIPELINE_TIMEOUT_MS / 1000} 秒已终止`);
        }
        if (result.stderrTail) {
            this.logger.warn("提取 stderr（尾部）：\n" + result.stderrTail);
        }
        if (result.code !== 0) {
            throw new BadGatewayException(`PDF 文本提取失败（退出码 ${result.code}）：${result.stderrTail.slice(-1200)}`);
        }
        const stat = await fs.promises.stat(outPath).catch(() => null);
        if (!stat || stat.size === 0) {
            throw new BadGatewayException("PDF 文本提取结果为空");
        }
    }

    // 调用既有 Python 管线生成复核 HTML（五个参数均为脚本既有参数，零新增，红线 6）
    // 成功返回产物路径；失败按 502/504 透传 stderr 摘要
    async buildReviewHtml(pdfPath: string, itemsPath: string, outPath: string, title: string): Promise<string> {
        const args = [
            path.join(this.skillDir, "scripts", "build_review_html.py"),
            "--pdf", pdfPath,
            "--items", itemsPath,
            "--out", outPath,
            "--vendor", path.join(this.skillDir, "assets", "vendor"),
            "--title", title,
        ];
        this.logger.log("spawn: python " + args.join(" "));
        const started = Date.now();
        const result = await this.runOnce("python", args, PIPELINE_TIMEOUT_MS, true);
        this.logger.log(`管线退出码 ${result.code}，耗时 ${Date.now() - started}ms`);

        if (result.timedOut) {
            throw new GatewayTimeoutException(`管线执行超过 ${PIPELINE_TIMEOUT_MS / 1000} 秒已终止，请尝试更小的 PDF`);
        }
        // stderr 全量进日志
        if (result.stderrTail) {
            this.logger.warn("管线 stderr（尾部）：\n" + result.stderrTail);
        }
        // 退出码 0 但产物缺失/为空同样视为失败（防假成功）
        if (result.code !== 0) {
            throw new BadGatewayException(`管线执行失败（退出码 ${result.code}）：${result.stderrTail.slice(-1200)}`);
        }
        const stat = await fs.promises.stat(outPath).catch(() => null);
        if (!stat || stat.size === 0) {
            throw new BadGatewayException("管线退出码为 0 但产物文件缺失或为空");
        }
        return outPath;
    }

    // 单次进程执行：参数数组不经 shell，规避转义与注入；detached 以便 Windows 按进程树终止
    private runOnce(cmd: string, args: string[], timeoutMs: number, collectStderr = false): Promise<ProcResult> {
        return new Promise((resolve) => {
            const child = spawn(cmd, args, { detached: true, windowsHide: true });
            const errLines: string[] = [];
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                this.logger.warn(`进程超过 ${timeoutMs}ms 未退出，按进程树终止 pid=${child.pid}`);
                if (process.platform === "win32") {
                    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
                } else {
                    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
                }
            }, timeoutMs);

            child.stderr?.on("data", (d: Buffer) => {
                if (collectStderr) errLines.push(d.toString());
            });
            child.stdout?.on("data", (d: Buffer) => {
                const text = d.toString().trim();
                if (text) this.logger.log(text);
            });
            child.on("error", (e) => {
                clearTimeout(timer);
                // ENOENT 等 spawn 失败：交由调用方区分（Python 探测场景转为 503）
                resolve({ code: -1, stderrTail: String(e), timedOut });
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({
                    code: code ?? -1,
                    stderrTail: errLines.slice(-20).join("\n"),
                    timedOut,
                });
            });
        });
    }
}
