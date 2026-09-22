/**
 * ============================================================================
 *  BlockBench Git 项目管理插件 (blockbench_git)
 * ============================================================================
 *  功能：
 *   1. GUI 管理工程所在 Git 仓库：初始化、提交（commit）、推送（push）、
 *      放弃更改、回退到指定提交（reset --hard）、查看历史
 *   2. 手动一键提交按钮 + 两种自动提交：
 *      - 保存计数：累计 N 次保存后自动提交
 *      - 定时：每 X 分钟自动提交；触发时可先自动保存项目（可配置）
 *   3. 初始化时自动为图像文件配置 Git LFS 追踪
 *      （GitHub 的 LFS 存储后端为 Xet，标准 git-lfs 客户端直接兼容）
 *
 *  权限需求（首次使用时 Blockbench 会弹窗询问）：
 *   - child_process：调用系统 git / git-lfs
 *   - fs（限定仓库目录）：初始化时写入 .gitattributes / .gitignore
 *
 *  依赖：系统已安装 Git（建议同时安装 git-lfs）。
 * ============================================================================
 */

const PLUGIN_ID = 'blockbench_git';
const LFS_DEFAULT_EXTS = 'png,jpg,jpeg,gif,webp,tga,bmp';
const GITIGNORE_CONTENT = '.DS_Store\nThumbs.db\ndesktop.ini\n*.tmp\n.bbgit_preview/\n';
const PREVIEW_DIR_NAME = '.bbgit_preview';

let P = {
	cp: null,                 // child_process（onload 时注入）
	events: [],               // Blockbench.on 返回的 Deletable 句柄
	actions: [],              // 注册的 Action
	settingDefs: [],          // 注册的 Setting
	timer: null,
	panel: null,              // Git 面板（可停靠/悬浮）
	vm: null,                 // 面板 Vue 实例
	states: new Map(),        // project.uuid -> 仓库状态
	gitAvailable: true,
};

const PathModule = require('path');

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }

function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeStr(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

function now() { let d = new Date(); return `${dateStr(d)} ${timeStr(d)}`; }

function toast(text, opts = {}) {
	new ToastNotification(PLUGIN_ID + '_toast', Object.assign({
		text, icon: 'device_hub', expire: 4000
	}, opts));
}

function toastError(text) {
	toast(text, { icon: 'warning', color: 'var(--color-error)', expire: 6000 });
}

function toastOK(text) {
	toast(text, { icon: 'check_circle', color: 'var(--color-confirm)' });
}

function gitExe() {
	return (settings.git_path && settings.git_path.value) || 'git';
}

function autoMessage() {
	let tpl = (settings.git_auto_commit_message.value || '').trim() || '自动 commit {date} {time}';
	let d = new Date();
	return tpl.replace('{date}', dateStr(d)).replace('{time}', timeStr(d));
}

function parseExts(csv) {
	let set = new Set();
	(csv || '').split(/[,;\s]+/).forEach(e => {
		e = e.trim().toLowerCase().replace(/^\./, '');
		if (/^[a-z0-9]{1,8}$/.test(e)) set.add(e);
	});
	return [...set];
}

function firstLine(text) {
	return String(text || '').split('\n')[0].slice(0, 120);
}

function showGitError(e) {
	let msg = e && e.message ? e.message : String(e);
	Blockbench.showMessageBox({
		title: 'Git 操作失败',
		icon: 'warning',
		message: msg.length > 2000 ? msg.slice(0, 2000) + '\n…' : msg,
		buttons: ['好']
	});
}

function promptInstallGit() {
	Blockbench.showMessageBox({
		title: '需要 Git',
		icon: 'warning',
		message: '未找到 git。请安装 Git（建议同时安装 git-lfs）后重启 Blockbench，或在 插件设置 中指定 git 路径。',
		buttons: ['打开下载页', '取消'],
		confirmIndex: 0,
		cancelIndex: 1
	}, btn => {
		if (btn === 0) Blockbench.openLink('https://git-scm.com/downloads');
	});
}

// ------------------------------------------------------------------
// Git 执行层
// ------------------------------------------------------------------

function gitRun(root, args) {
	return new Promise(resolve => {
		P.cp.execFile(gitExe(), ['-c', 'core.quotepath=false', ...args], {
			cwd: root,
			windowsHide: true,
			maxBuffer: 16 * 1024 * 1024
		}, (err, stdout, stderr) => {
			let enoent = !!(err && err.code === 'ENOENT');
			if (enoent) P.gitAvailable = false;
			resolve({
				code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
				stdout: stdout || '',
				stderr: stderr || '',
				enoent
			});
		});
	});
}

async function runOrThrow(root, args) {
	let r = await gitRun(root, args);
	if (r.enoent) throw new Error('未找到 git 可执行文件（可在 插件设置 中指定路径，或安装 Git）');
	if (r.code !== 0) {
		throw new Error(`git ${args[0]} 失败（退出码 ${r.code}）：\n${(r.stderr || r.stdout || '无输出').trim()}`);
	}
	return r;
}

async function findRepoRoot(dir) {
	if (!dir || !P.gitAvailable) return null;
	let r = await gitRun(dir, ['rev-parse', '--show-toplevel']);
	if (r.enoent) return null;
	if (r.code === 0 && r.stdout.trim()) return PathModule.normalize(r.stdout.trim());
	return null;
}

// ------------------------------------------------------------------
// 仓库状态（按工程隔离）
// ------------------------------------------------------------------

function isPreviewPath(p) {
	return typeof p === 'string' && p.replace(/\\/g, '/').includes('/' + PREVIEW_DIR_NAME + '/');
}

function emptyView() {
	return { branch: '', upstream: '', remote: '', ahead: 0, behind: 0, files: [], clean: true, noCommits: false };
}

async function ensureState(project) {
	if (!project || !project.save_path || !P.gitAvailable) return null;
	if (isPreviewPath(project.save_path)) return null; // 预览工程不参与 Git 管理
	let st = P.states.get(project.uuid);
	if (st) return st;
	let root = await findRepoRoot(PathModule.dirname(project.save_path));
	if (!root) {
		P.states.delete(project.uuid);
		return null;
	}
	st = {
		uuid: project.uuid,
		root,
		busy: false,
		saveCount: 0,
		lastCommitTs: 0,
		timedPending: false,
		timedFailTimer: null,
		previews: {},
		view: emptyView()
	};
	P.states.set(project.uuid, st);
	refreshPreviews(st).then(syncVm).catch(() => {});
	return st;
}

// ------------------------------------------------------------------
// 历史提交预览（git worktree 临时分支，不影响当前工程）
// ------------------------------------------------------------------

async function refreshPreviews(st) {
	st.previews = st.previews || {};
	let r = await gitRun(st.root, ['worktree', 'list', '--porcelain']);
	if (r.code !== 0) return st.previews;
	let found = {};
	let cur = null;
	for (let line of r.stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			cur = { dir: line.slice(9).trim() };
		} else if (line.startsWith('branch ') && cur) {
			cur.branch = line.slice(7).trim().replace('refs/heads/', '');
		} else if (line === '' && cur) {
			if (isPreviewPath(cur.dir)) {
				found[PathModule.basename(cur.dir)] = { dir: cur.dir, branch: cur.branch || '', bbmodel: '' };
			}
			cur = null;
		}
	}
	st.previews = found;
	syncVm();
	return st.previews;
}

async function openPreviewProject(st, short) {
	let p = st.previews[short];
	if (!p) return false;
	let sfs = require('fs', { scope: st.root });
	let candidates = [];
	try {
		if (sfs && sfs.existsSync(p.dir)) {
			for (let f of sfs.readdirSync(p.dir)) {
				if (/\.bbmodel$/i.test(f)) candidates.push(f);
			}
		}
	} catch (e) { /* 目录不可读时仅提示 */ }
	let target = null;
	if (Project && Project.save_path) {
		let curName = PathModule.basename(Project.save_path);
		if (candidates.includes(curName)) target = curName;
	}
	if (!target && candidates.length) target = candidates[0];
	if (!target) {
		toastError('临时分支已创建，但该提交中没有找到 .bbmodel 文件');
		return false;
	}
	p.bbmodel = PathModule.join(p.dir, target);
	syncVm();
	Blockbench.read([p.bbmodel], {}, files => {
		if (files && files[0]) loadModelFile(files[0]);
	});
	return true;
}

async function previewCommit(st, commit) {
	if (st.busy) return;
	st.busy = true;
	syncVm();
	try {
		ensureGitignore(st.root); // 保证预览目录被忽略，status 保持干净
		let full = (await runOrThrow(st.root, ['rev-parse', commit.hash])).stdout.trim();
		let short = full.slice(0, 7);
		let dir = PathModule.join(st.root, PREVIEW_DIR_NAME, short);
		await refreshPreviews(st);
		if (!st.previews[short]) {
			let branch = 'temp/preview-' + short;
			let r = await gitRun(st.root, ['worktree', 'add', '-b', branch, dir, short]);
			if (r.code !== 0) {
				// 分支已存在（上次预览后未删）→ 直接复用分支
				r = await gitRun(st.root, ['worktree', 'add', dir, branch]);
			}
			if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'git worktree add 失败').trim());
			await refreshPreviews(st);
		}
		let p = st.previews[short];
		toastOK(`已检出临时分支 ${p.branch}，正在打开历史版本`);
		syncVm();
		await openPreviewProject(st, short);
		return true;
	} catch (e) {
		showGitError(e);
		return false;
	} finally {
		st.busy = false;
		syncVm();
	}
}

async function closePreview(st, short) {
	if (st.busy) return;
	let p = st.previews[short];
	if (!p) return;
	// 若预览工程还开着，先关闭其标签页
	let openTab = ModelProject.all.find(pr => pr.save_path && isPreviewPath(pr.save_path));
	if (openTab) {
		try {
			await openTab.close();
		} catch (e) { /* 关闭被取消或失败时保留预览 */ }
		if (ModelProject.all.some(pr => pr.save_path && isPreviewPath(pr.save_path))) {
			toastError('预览工程标签页未关闭（可能有未保存更改），已保留临时分支');
			return;
		}
	}
	st.busy = true;
	syncVm();
	try {
		await runOrThrow(st.root, ['worktree', 'remove', '--force', p.dir]);
		await gitRun(st.root, ['branch', '-D', p.branch]);
		await refreshPreviews(st);
		toastOK('已关闭预览并删除临时分支 ' + p.branch);
	} catch (e) {
		showGitError(e);
		await refreshPreviews(st);
	} finally {
		st.busy = false;
		syncVm();
	}
}

function selectedState() {
	return Project ? P.states.get(Project.uuid) : undefined;
}

function parseStatus(stdout) {
	let out = { branch: '', ahead: 0, behind: 0, files: [], clean: true, noCommits: false };
	let tokens = stdout.split('\0');
	for (let i = 0; i < tokens.length; i++) {
		let t = tokens[i];
		if (!t) continue;
		if (t.startsWith('## ')) {
			let head = t.slice(3);
			let m = head.match(/\[ahead (\d+)(?:, behind (\d+))?\]/);
			if (m) { out.ahead = +m[1]; out.behind = m[2] ? +m[2] : 0; }
			let nom = head.match(/^No commits yet on (.+)$/);
			if (nom) { out.branch = nom[1].trim(); out.noCommits = true; }
			else out.branch = head.split('...')[0].split(' ')[0].trim();
			out.upstream = nom ? '' : (head.split('...')[1] || '').split(' ')[0].trim();
			continue;
		}
		// porcelain 条目：XY + 空格 + 路径；重命名/复制会额外跟一个原路径 token，跳过
		if (t.length > 3 && t[2] === ' ') {
			let xy = t.slice(0, 2);
			if ((xy[0] === 'R' || xy[0] === 'C') && tokens[i + 1]) i++;
			out.files.push({ s: xy.trim() || '?', path: t.slice(3) });
		}
	}
	out.clean = out.files.length === 0;
	return out;
}

async function refreshStatus(st) {
	let r = await runOrThrow(st.root, ['status', '--porcelain=v1', '-b', '-z']);
	let info = parseStatus(r.stdout);
	Object.assign(st.view, info);
	st.view.remote = await getRemoteUrl(st.root);
	syncVm();
	return info;
}

async function refreshHistory(st) {
	let r = await gitRun(st.root, [
		'log', '-n', '50',
		'--date=format-local:%Y-%m-%d %H:%M',
		'--pretty=format:%h%x09%ad%x09%an%x09%s'
	]);
	if (r.code !== 0) return [];
	return r.stdout.split('\n').filter(Boolean).map(line => {
		let [hash, date, author, ...rest] = line.split('\t');
		return { hash, date, author, msg: rest.join('\t') };
	});
}

// ------------------------------------------------------------------
// Vue 视图同步
// ------------------------------------------------------------------

function syncVm() {
	let vm = P.vm;
	if (!vm) return;
	let st = selectedState();
	vm.hasRepo = !!st;
	if (st) {
		vm.root = st.root;
		vm.busy = st.busy;
		vm.branch = st.view.branch;
		vm.ahead = st.view.ahead;
		vm.behind = st.view.behind;
		vm.files = st.view.files;
		vm.clean = st.view.clean;
		vm.remote = st.view.remote;
		vm.upstream = st.view.upstream || '';
		vm.previews = st.previews || {};
	} else {
		vm.busy = false;
		vm.remote = '';
		vm.upstream = '';
		vm.previews = {};
	}
}

// ------------------------------------------------------------------
// 核心操作：提交 / 推送 / 放弃 / 回退
// ------------------------------------------------------------------

async function doCommit(st, message, opts = {}) {
	let { push = false, silent = false, auto = false } = opts;
	if (st.busy) return false;
	st.busy = true;
	syncVm();
	try {
		let info = await refreshStatus(st);
		if (info.clean) {
			if (!auto) toast('没有可提交的变更');
			return false;
		}
		await runOrThrow(st.root, ['add', '-A']);
		let r = await runOrThrow(st.root, ['commit', '-m', message]);
		let hash = (r.stdout.match(/([0-9a-f]{7,40})\]/) || [])[1] || '';
		st.lastCommitTs = Date.now();
		st.saveCount = 0;
		await refreshStatus(st);
		let label = auto ? '自动提交完成' : '提交完成';
		if (auto) toastOK(`${label}${hash ? ` (${hash})` : ''} ${timeStr(new Date())}`);
		else toastOK(`${label}${hash ? ` (${hash})` : ''}`);
		if (push) await doPush(st, auto);
		return true;
	} catch (e) {
		if (auto) toastError('自动提交失败：' + firstLine(e.message));
		else showGitError(e);
		return false;
	} finally {
		st.busy = false;
		syncVm();
	}
}

async function doPush(st, silent = false) {
	try {
		let rem = await gitRun(st.root, ['remote']);
		if (!rem.stdout.trim()) {
			toastError('未配置远程仓库（git remote add origin <url>）');
			return false;
		}
		let r = await gitRun(st.root, ['push']);
		if (r.code !== 0 && /no upstream|has no upstream/i.test(r.stderr) && st.view.branch) {
			r = await gitRun(st.root, ['push', '-u', 'origin', st.view.branch]);
		}
		if (r.code !== 0) {
			let msg = (r.stderr || r.stdout).trim();
			if (silent) toastError('推送失败：' + firstLine(msg));
			else showGitError(new Error(msg));
			return false;
		}
		toastOK('推送成功');
		await refreshStatus(st);
		return true;
	} catch (e) {
		if (silent) toastError('推送失败：' + firstLine(e.message));
		else showGitError(e);
		return false;
	}
}

async function getRemoteUrl(root) {
	let r = await gitRun(root, ['remote', 'get-url', 'origin']);
	return r.code === 0 ? r.stdout.trim() : '';
}

function setRemoteUrl(st) {
	Blockbench.textPrompt('远程仓库地址', st.view.remote || '', async url => {
		url = (url || '').trim();
		if (!url || st.busy) return;
		st.busy = true;
		syncVm();
		try {
			if (st.view.remote) {
				await runOrThrow(st.root, ['remote', 'set-url', 'origin', url]);
			} else {
				await runOrThrow(st.root, ['remote', 'add', 'origin', url]);
			}
			toastOK((st.view.remote ? '已修改远程仓库：' : '已设置远程仓库：') + url);
			await refreshStatus(st);
			await fetchRemoteGap(st);
		} catch (e) {
			showGitError(e);
		} finally {
			st.busy = false;
			syncVm();
		}
	}, { placeholder: 'https://github.com/user/repo.git 或 git@github.com:user/repo.git', description: '配置后可用旁边的按钮拉取并查看与远程的差距' });
}

async function resolveUpstreamRef(st) {
	// 返回上游分支引用（@{upstream} 或 origin/<branch>），不存在时返回 null
	let up = await gitRun(st.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
	if (up.code === 0 && up.stdout.trim()) return up.stdout.trim();
	let candidate = 'origin/' + (st.view.branch || '');
	let verify = await gitRun(st.root, ['rev-parse', '--verify', '--quiet', candidate]);
	return verify.code === 0 ? candidate : null;
}

async function fetchRemoteGap(st) {
	if (st.busy) return;
	st.busy = true;
	syncVm();
	try {
		let rem = await gitRun(st.root, ['remote']);
		if (!rem.stdout.trim()) {
			toastError('未配置远程仓库，请先点击“设置远程”按钮');
			return false;
		}
		await runOrThrow(st.root, ['fetch', '--quiet', 'origin']);
		let upstream = await resolveUpstreamRef(st);
		if (!upstream) {
			st.view.ahead = 0;
			st.view.behind = 0;
			st.view.upstream = '';
			syncVm();
			toastOK('拉取完成：远程还没有该分支，推送后会自动建立关联');
			return true;
		}
		let gap = await runOrThrow(st.root, ['rev-list', '--left-right', '--count', 'HEAD...' + upstream]);
		let parts = gap.stdout.trim().split(/\s+/);
		st.view.ahead = +parts[0] || 0;
		st.view.behind = +parts[1] || 0;
		st.view.upstream = upstream;
		syncVm();
		if (st.view.ahead || st.view.behind) toastOK(`拉取完成：本地领先 ${st.view.ahead} 个提交，落后 ${st.view.behind} 个提交`);
		else toastOK('拉取完成：与远程一致');
		return true;
	} catch (e) {
		showGitError(e);
		return false;
	} finally {
		st.busy = false;
		syncVm();
	}
}

async function forcePush(st) {
	// 强制推送：先 fetch 刷新远端引用，再用 --force-with-lease 覆盖（防止覆盖他人刚推送的新提交）
	if (st.busy) return false;
	st.busy = true;
	syncVm();
	try {
		if (!(await getRemoteUrl(st.root))) {
			toastError('未配置远程仓库，请先点击“设置远程”按钮');
			return false;
		}
		await runOrThrow(st.root, ['fetch', '--quiet', 'origin']);
		let r = await gitRun(st.root, ['push', '--force-with-lease']);
		if (r.code !== 0 && /no upstream/i.test(r.stderr) && st.view.branch) {
			r = await gitRun(st.root, ['push', '--force-with-lease', '-u', 'origin', st.view.branch]);
		}
		if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
		toastOK('已强制推送：远程 ' + (st.view.branch || 'HEAD') + ' 分支已被本地覆盖');
		await refreshStatus(st);
		return true;
	} catch (e) {
		showGitError(e);
		return false;
	} finally {
		st.busy = false;
		syncVm();
	}
}

async function forcePull(st, cleanUntracked) {
	// 强制拉取：用远程分支覆盖本地（丢弃未提交更改与未推送提交）
	if (st.busy) return false;
	st.busy = true;
	syncVm();
	try {
		await runOrThrow(st.root, ['fetch', '--quiet', 'origin']);
		let upstream = await resolveUpstreamRef(st);
		if (!upstream) {
			toastError('远程上还没有该分支（origin/' + (st.view.branch || '') + '），无法覆盖本地');
			return false;
		}
		await runOrThrow(st.root, ['reset', '--hard', upstream]);
		if (cleanUntracked) await runOrThrow(st.root, ['clean', '-fd']);
		st.saveCount = 0;
		st.lastCommitTs = Date.now();
		await refreshStatus(st);
		st.view.ahead = 0;
		st.view.behind = 0;
		st.view.upstream = upstream;
		syncVm();
		toastOK('已用 ' + upstream + ' 覆盖本地，请重新打开工程加载该版本');
		return true;
	} catch (e) {
		showGitError(e);
		return false;
	} finally {
		st.busy = false;
		syncVm();
	}
}

async function discardChanges(st) {
	if (st.busy) return;
	st.busy = true;
	syncVm();
	let n = 0;
	try {
		n = (await refreshStatus(st)).files.length;
	} catch (e) { /* 状态获取失败时仍允许继续，使用缓存列表 */ }
	st.busy = false;
	syncVm();
	if (n === 0) {
		toast('没有可放弃的变更');
		return;
	}
	Blockbench.showMessageBox({
		title: '放弃未提交的更改',
		icon: 'warning',
		message: `将把 ${n} 个变更文件还原到上次提交（git reset --hard）。此操作不可撤销。`,
		buttons: ['放弃更改', '取消'],
		confirmIndex: 0,
		cancelIndex: 1,
		checkboxes: {
			clean_untracked: { text: '同时删除未跟踪的文件（git clean -fd）', value: false }
		}
	}, async (btn, result) => {
		if (btn !== 0) return;
		if (st.busy) return;
		st.busy = true;
		syncVm();
		try {
			await runOrThrow(st.root, ['reset', '--hard', 'HEAD']);
			if (result && result.clean_untracked) await runOrThrow(st.root, ['clean', '-fd']);
			await refreshStatus(st);
			toastOK('已放弃未提交的更改');
		} catch (e) {
			showGitError(e);
		} finally {
			st.busy = false;
			syncVm();
		}
	});
}

function resetToCommit(st, commit) {
	let warn = st.view.ahead
		? '\n\n注意：当前分支有已推送的领先提交，回退后再次推送需要 force push（本插件不会自动 force push）。'
		: '';
	Blockbench.showMessageBox({
		title: '回退到此提交',
		icon: 'warning',
		message: `将把整个仓库重置到 ${commit.hash}（${commit.msg}），之后的提交将从当前分支移除。${warn}`,
		buttons: ['回退', '取消'],
		confirmIndex: 0,
		cancelIndex: 1
	}, async btn => {
		if (btn !== 0) return;
		if (st.busy) return;
		st.busy = true;
		syncVm();
		try {
			await runOrThrow(st.root, ['reset', '--hard', commit.hash]);
			st.saveCount = 0;
			st.lastCommitTs = Date.now();
			await refreshStatus(st);
			toastOK(`已回退到 ${commit.hash}`);
		} catch (e) {
			showGitError(e);
		} finally {
			st.busy = false;
			syncVm();
		}
	});
}

// ------------------------------------------------------------------
// 自动提交（保存计数 + 定时）
// ------------------------------------------------------------------

async function autoCommit(st) {
	await doCommit(st, autoMessage(), { push: !!settings.git_auto_push.value, auto: true, silent: true });
}

async function onSavedChanged(e) {
	if (!e || !e.saved || !e.project) return;
	let st = await ensureState(e.project);
	if (!st || st.busy) return;

	// 定时提交流程的保存回调：先保存的工程已落盘，直接提交
	if (st.timedPending) {
		st.timedPending = false;
		clearTimeout(st.timedFailTimer);
		st.timedFailTimer = null;
		await autoCommit(st);
		return;
	}

	// 保存计数
	let mode = settings.git_auto_commit_mode.value;
	if (mode !== 'count' && mode !== 'both') return;
	st.saveCount++;
	let threshold = Math.max(1, +settings.git_save_count.value || 10);
	if (st.saveCount >= threshold) {
		st.saveCount = 0;
		await autoCommit(st);
	}
}

async function onTimer() {
	if (!Project || !Project.save_path || isPreviewPath(Project.save_path)) return;
	let mode = settings.git_auto_commit_mode.value;
	if (mode !== 'time' && mode !== 'both') return;
	let st = selectedState() || await ensureState(Project);
	if (!st || st.busy) return;

	let intervalMs = Math.max(1, +settings.git_commit_interval.value || 10) * 60000;
	if (Date.now() - (st.lastCommitTs || 0) < intervalMs) return;

	if (settings.git_save_before_timed.value) {
		// 先保存项目；保存完成事件（saved_state_changed）会消费 timedPending 并提交
		st.timedPending = true;
		clearTimeout(st.timedFailTimer);
		st.timedFailTimer = setTimeout(() => { st.timedPending = false; }, 15000);
		BarItems.save_project.trigger();
	} else {
		await autoCommit(st);
	}
}

// ------------------------------------------------------------------
// 初始化仓库（含 LFS/Xet 配置）
// ------------------------------------------------------------------

async function ensureLfsAttributes(root, exts) {
	// 幂等补全 .gitattributes 的 LFS 行，返回本次新增的扩展名；无文件权限时抛错，由调用方决定静默或提示
	let sfs = require('fs', { scope: root });
	if (!sfs) throw new Error('文件访问权限被拒绝，无法写入 .gitattributes。请在权限提示中选择允许后重试。');
	let attrPath = PathModule.join(root, '.gitattributes');
	let existed = sfs.existsSync(attrPath);
	let lines = existed ? sfs.readFileSync(attrPath, 'utf-8').split(/\r?\n/) : ['# 由 BlockBench Git 插件生成：图像文件使用 Git LFS 追踪（GitHub Xet 兼容）'];
	let added = [];
	for (let ext of exts) {
		let line = `*.${ext} filter=lfs diff=lfs merge=lfs -text`;
		if (!lines.some(l => l.trim() === line)) {
			lines.push(line);
			added.push(ext);
		}
	}
	if (added.length) {
		let content = lines.join('\n');
		if (!content.endsWith('\n')) content += '\n';
		sfs.writeFileSync(attrPath, content, 'utf-8');
	}
	return added;
}

function ensureGitignore(root) {
	// 幂等补全 .gitignore 默认条目，返回是否写入了文件；无文件权限时静默返回 false
	let sfs = require('fs', { scope: root });
	if (!sfs) return false;
	let p = PathModule.join(root, '.gitignore');
	let lines = sfs.existsSync(p) ? sfs.readFileSync(p, 'utf-8').split(/\r?\n/) : [];
	let changed = false;
	for (let entry of GITIGNORE_CONTENT.trim().split('\n')) {
		if (!lines.some(l => l.trim() === entry)) {
			lines.push(entry);
			changed = true;
		}
	}
	if (changed) {
		let content = lines.join('\n');
		if (!content.endsWith('\n')) content += '\n';
		sfs.writeFileSync(p, content, 'utf-8');
	}
	return changed;
}

async function autoConfigGitFilters(root) {
	// 打开工程/修改设置时自动检测并补全过滤配置；静默失败，不阻塞打开流程
	if (!settings.git_lfs_auto_config.value) return;
	let exts = parseExts(settings.git_lfs_extensions.value);
	if (!exts.length) return;
	try {
		let addedAttrs = await ensureLfsAttributes(root, exts);
		let addedIgnore = ensureGitignore(root);
		if (addedAttrs.length) toastOK('已补充 LFS 图像追踪：' + addedAttrs.map(e => '*.' + e).join('、'));
		if (addedIgnore) toastOK('已补全 .gitignore 默认条目');
	} catch (e) {
		console.warn('[blockbench_git] 自动配置过滤规则跳过：' + (e.message || e));
	}
}

async function initRepo(root, opts) {
	if (!root) {
		toastError('请选择仓库目录');
		return;
	}
	root = PathModule.normalize(root);
	let existing = await findRepoRoot(root);
	if (existing) {
		Blockbench.showMessageBox({
			title: '初始化 Git 仓库',
			message: `所选目录已在 Git 仓库中：\n${existing}`,
			buttons: ['好']
		});
		return;
	}
	if (!P.gitAvailable) {
		promptInstallGit();
		return;
	}

	let st = {
		uuid: Project ? Project.uuid : 'adhoc',
		root, busy: true, saveCount: 0, lastCommitTs: 0,
		timedPending: false, timedFailTimer: null, previews: {}, view: emptyView()
	};
	if (Project) P.states.set(Project.uuid, st);
	syncVm();

	try {
		// git init（-b main 需要较新 git，失败则回退）
		let r = await gitRun(root, ['init', '-b', 'main']);
		if (r.code !== 0) {
			await runOrThrow(root, ['init']);
			await gitRun(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
		}

		// LFS 图像追踪
		let lfsMissing = false;
		if (opts.lfs) {
			let exts = parseExts(opts.exts || settings.git_lfs_extensions.value);
			if (!exts.length) exts = parseExts(LFS_DEFAULT_EXTS);
			if ((await gitRun(root, ['lfs', 'install', '--local'])).code === 0) {
				for (let ext of exts) await gitRun(root, ['lfs', 'track', '*.' + ext]);
			} else {
				lfsMissing = true;
				await ensureLfsAttributes(root, exts);
			}
			settings.git_lfs_extensions.set((opts.exts || LFS_DEFAULT_EXTS).trim() || LFS_DEFAULT_EXTS);
			if (lfsMissing) toast('未检测到 git-lfs，已手动写入 .gitattributes；建议安装 git-lfs', { icon: 'warning', expire: 6000 });
		}

		if (opts.gitignore) ensureGitignore(root);

		if (opts.commit0) {
			await runOrThrow(root, ['add', '-A']);
			await gitRun(root, ['commit', '-m', 'Initial commit']); // 空目录时 "nothing to commit" 可忽略
		}

		await refreshStatus(st);
		toastOK('Git 仓库已初始化：' + root);
	} catch (e) {
		showGitError(e);
	} finally {
		st.busy = false;
		syncVm();
	}
}

function defaultRepoRoot() {
	return (Project && Project.save_path) ? PathModule.dirname(Project.save_path) : '';
}

function openInitDialog() {
	new Dialog({
		id: PLUGIN_ID + '_init',
		title: '初始化 Git 仓库',
		width: 480,
		form: {
			root: { label: '仓库位置', type: 'folder', value: defaultRepoRoot(), description: '选择 Git 仓库根目录（默认为工程文件所在目录）' },
			lfs: { label: '启用 LFS 图像追踪（GitHub Xet 兼容）', type: 'checkbox', value: true },
			exts: { label: 'LFS 追踪的图像扩展名（逗号分隔）', type: 'text', value: settings.git_lfs_extensions.value },
			gitignore: { label: '生成 .gitignore（系统文件与临时文件）', type: 'checkbox', value: true },
			commit0: { label: '创建初始提交', type: 'checkbox', value: true }
		},
		onConfirm: f => { initRepo(f.root, f); }
	}).show();
}

// ------------------------------------------------------------------
// 管理器对话框
// ------------------------------------------------------------------

function readSettingsView() {
	return {
		mode: settings.git_auto_commit_mode.value,
		saveCount: +settings.git_save_count.value,
		interval: +settings.git_commit_interval.value,
		saveBefore: !!settings.git_save_before_timed.value,
		autoPush: !!settings.git_auto_push.value,
		autoConfig: !!settings.git_lfs_auto_config.value,
		msgTpl: settings.git_auto_commit_message.value,
		lfsExts: settings.git_lfs_extensions.value,
		gitPath: settings.git_path.value
	};
}

function writeSettingsView(s) {
	settings.git_auto_commit_mode.set(['both', 'count', 'time', 'off'].includes(s.mode) ? s.mode : 'both');
	settings.git_save_count.set(Math.round(Math.min(1000, Math.max(1, +s.saveCount || 10))));
	settings.git_commit_interval.set(Math.round(Math.min(10080, Math.max(1, +s.interval || 10))));
	settings.git_save_before_timed.set(!!s.saveBefore);
	settings.git_auto_push.set(!!s.autoPush);
	settings.git_lfs_auto_config.set(!!s.autoConfig);
	if (s.msgTpl && s.msgTpl.trim()) settings.git_auto_commit_message.set(s.msgTpl.trim());
	let prevLfsExts = settings.git_lfs_extensions.value;
	if (s.lfsExts != null) settings.git_lfs_extensions.set(s.lfsExts.trim() || LFS_DEFAULT_EXTS);
	if (s.gitPath != null) settings.git_path.set(s.gitPath.trim() || 'git');
	// LFS 扩展名变更时，立即对当前仓库补全过滤配置
	let st = selectedState();
	if (st && settings.git_lfs_auto_config.value && settings.git_lfs_extensions.value !== prevLfsExts) {
		autoConfigGitFilters(st.root);
	}
}

function openGitPanel() {
	if (!P.gitAvailable) {
		promptInstallGit();
		return;
	}
	if (!P.panel) buildGitPanel();
	if (P.panel.folded || !P.panel.isVisible()) {
		P.panel.fold(false);
		P.panel.moveToFront();
		refreshPanel();
	} else {
		P.panel.fold(true);
	}
}

function buildGitPanel() {
	P.panel = new Panel('blockbench_git', {
		name: 'Git 项目管理',
		icon: 'account_tree',
		plugin: PLUGIN_ID,
		condition: () => !!Project,
		resizable: true,
		min_height: 150,
		expand_button: true,
		default_position: {
			slot: 'right_bar',
			float_position: [140, 140],
			float_size: [460, 500],
			height: 320
		},
		component: {
			data() {
				return {
					page: 'status',
					tabs: { status: '状态', commit: '提交', history: '历史', settings: '设置' },
					hasRepo: false,
					busy: false,
					root: '',
					branch: '',
					ahead: 0,
					behind: 0,
					files: [],
					clean: true,
					history: [],
					message: '',
					previews: {},
					pushAfter: !!settings.git_auto_push.value,
					s: readSettingsView()
				};
			},
			methods: {
				refresh() { refreshPanel(); },
				openInit() { openInitDialog(); },
				switchPage(page) {
					this.page = page;
					if (page === 'history') refreshHistoryPage();
					else syncVm();
				},
				commitQuick() {
					let st = selectedState();
					if (!st) return;
					Blockbench.showMessageBox({
						title: '提交全部变更',
						icon: 'check_circle',
						message: `将把 ${this.files.length} 个变更文件提交到分支 ${this.branch || 'HEAD'}。`,
						buttons: ['提交', '取消'],
						confirmIndex: 0,
						cancelIndex: 1
					}, btn => {
						if (btn === 0) doCommit(st, '手动提交 ' + now());
					});
				},
				commitWithMessage() {
					let st = selectedState();
					let msg = (this.message || '').trim();
					if (!st || !msg) return;
					Blockbench.showMessageBox({
						title: '提交变更',
						icon: 'check_circle',
						message: `将把 ${this.files.length} 个变更文件提交到分支 ${this.branch || 'HEAD'}。\n消息：${msg}`,
						buttons: ['提交', '取消'],
						confirmIndex: 0,
						cancelIndex: 1
					}, btn => {
						if (btn !== 0) return;
						doCommit(st, msg, { push: this.pushAfter }).then(ok => {
							if (ok) this.message = '';
						});
					});
				},
				pushNow() {
					let st = selectedState();
					if (!st) return;
					Blockbench.showMessageBox({
						title: '推送到远程',
						icon: 'cloud_upload',
						message: `将把分支 ${this.branch || 'HEAD'} 推送到远程 ${this.remote || '（未设置）'}（领先 ${this.ahead} 个提交）。`,
						buttons: ['推送', '取消'],
						confirmIndex: 0,
						cancelIndex: 1
					}, btn => {
						if (btn === 0) doPush(st, false);
					});
				},
				openSyncMenu(e) {
					new Menu([
						{ name: '强制推送（覆盖远程）', icon: 'cloud_upload', click: () => this.forcePushNow() },
						{ name: '强制拉取（远程覆盖本地）', icon: 'cloud_download', click: () => this.forcePullNow() }
					]).open(e);
				},
				forcePushNow() {
					let st = selectedState();
					if (!st) return;
					Blockbench.showMessageBox({
						title: '强制推送（覆盖远程）',
						icon: 'warning',
						message: `将强制覆盖远程 ${this.remote || '（未设置）'} 上的 ${this.branch || 'HEAD'} 分支！\n远程上不在本地的提交将永久丢失，此操作不可撤销。`,
						buttons: ['强制推送', '取消'],
						confirmIndex: 0,
						cancelIndex: 1
					}, btn => {
						if (btn === 0) forcePush(st);
					});
				},
				forcePullNow() {
					let st = selectedState();
					if (!st) return;
					Blockbench.showMessageBox({
						title: '强制拉取（远程覆盖本地）',
						icon: 'warning',
						message: `将用远程 ${this.remote || '（未设置）'} 的 ${this.upstream || ('origin/' + (this.branch || ''))} 覆盖本地仓库！\n未提交的更改和未推送的提交将永久丢失，完成后请重新打开工程以加载远程版本。此操作不可撤销。`,
						buttons: ['强制拉取', '取消'],
						confirmIndex: 0,
						cancelIndex: 1,
						checkboxes: {
							clean_untracked: { text: '同时删除未跟踪的文件（git clean -fd）', value: false }
						}
					}, (btn, result) => {
						if (btn === 0) forcePull(st, result && result.clean_untracked);
					});
				},
				editRemote() {
					let st = selectedState();
					if (st) setRemoteUrl(st);
				},
				fetchDiff() {
					let st = selectedState();
					if (st) fetchRemoteGap(st);
				},
				discard() {
					let st = selectedState();
					if (st) discardChanges(st);
				},
				resetTo(h) {
					let st = selectedState();
					if (st) resetToCommit(st, h);
				},
				preview(h) {
					let st = selectedState();
					if (st) previewCommit(st, h);
				},
				openPreview(h) {
					let st = selectedState();
					if (st && st.previews[h.hash]) openPreviewProject(st, h.hash.slice(0, 7));
				},
				closePreviewRow(h) {
					let st = selectedState();
					if (st && st.previews[h.hash]) closePreview(st, h.hash.slice(0, 7));
				},
				applySettings() { writeSettingsView(this.s); }
			},
			template: `
<div>
	<div style="display:flex; gap:4px; margin-bottom:8px; border-bottom:1px solid var(--color-border);">
		<div v-for="(label, key) in tabs" :key="key" @click="switchPage(key)"
			:style="{padding:'3px 10px 5px', cursor:'pointer', fontSize:'13px',
				borderBottom: page === key ? '2px solid var(--color-accent)' : '2px solid transparent',
				color: page === key ? 'var(--color-accent)' : 'var(--color-subtle)'}">
			{{ label }}
		</div>
	</div>

	<div v-if="page === 'status'">
	<div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
		<template v-if="hasRepo">
			<i class="material-icons" style="font-size:16px;">device_hub</i>
			<b>{{ branch || 'HEAD' }}</b>
			<span v-if="ahead || behind" style="color:var(--color-subtle);">↑{{ ahead }} ↓{{ behind }}</span>
			<span :style="{color: clean ? 'var(--color-confirm)' : 'var(--color-error)'}">
				{{ clean ? '工作区干净' : (files.length + ' 个变更') }}
			</span>
			<div style="flex:1"></div>
			<div class="tool" title="刷新" @click="refresh()"><i class="material-icons">refresh</i></div>
		</template>
		<template v-else>
			<span style="color:var(--color-subtle);">当前工程尚未纳入 Git 管理</span>
			<div style="flex:1"></div>
			<div class="tool" title="初始化仓库" @click="openInit()"><i class="material-icons">add_circle_outline</i></div>
		</template>
	</div>

		<div v-if="hasRepo">
			<div style="max-height:280px; overflow-y:auto; border:1px solid var(--color-border); border-radius:6px;">
				<div v-if="busy" style="padding:8px 12px; color:var(--color-subtle);">Git 操作中…</div>
				<div v-else-if="clean" style="padding:8px 12px; color:var(--color-subtle);">无变更</div>
				<div v-else v-for="f in files" :key="f.path" style="display:flex; gap:10px; padding:3px 12px; align-items:center;">
					<span style="min-width:24px; text-align:center; font-family:var(--font-code); color:var(--color-subtle);">{{ f.s }}</span>
					<span style="font-family:var(--font-code); word-break:break-all;">{{ f.path }}</span>
				</div>
			</div>
			<div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
				<button class="confirm_btn" :disabled="busy || clean" @click="commitQuick()">提交全部</button>
				<button :disabled="busy" @click="pushNow()">推送</button>
				<button :disabled="busy" title="强制推送 / 强制拉取" @click="openSyncMenu($event)">强制同步 ▾</button>
				<div style="flex:1"></div>
				<button :disabled="busy || clean" style="color:var(--color-error);" @click="discard()">放弃更改</button>
			</div>
			<div style="margin-top:8px; color:var(--color-subtle); font-size:12px; word-break:break-all;">仓库根目录：{{ root }}</div>
			<div v-if="hasRepo" style="display:flex; gap:6px; align-items:center; margin-top:6px; min-width:0;">
				<span style="color:var(--color-subtle); flex-shrink:0;">远程</span>
				<span style="flex:1; font-size:11px; font-family:var(--font-code); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" :title="remote">{{ remote || '未配置' }}</span>
				<div class="tool" title="设置 / 修改远程仓库地址" @click="editRemote()"><i class="material-icons">edit</i></div>
				<div class="tool" title="拉取远程并计算与本地差距" @click="fetchDiff()"><i class="material-icons">sync</i></div>
			</div>
			<div v-if="hasRepo && remote && !upstream" style="color:var(--color-subtle); font-size:11px; margin-top:4px;">已配置远程但尚未关联上游分支，推送后会自动建立关联。</div>
			<div v-if="hasRepo && remote && upstream && (ahead || behind)" style="color:var(--color-subtle); font-size:11px; margin-top:4px;">
				与 {{ upstream }} 相比：领先 {{ ahead }}，落后 {{ behind }}（点击 sync 图标拉取刷新）
			</div>
		</div>
		<div v-else style="color:var(--color-subtle);">
			保存工程后，可点击右上角按钮初始化仓库。初始化时将为图像文件配置 LFS 追踪。
		</div>
	</div>

	<div v-if="page === 'commit'">
		<div v-if="hasRepo">
			<textarea v-model="message" rows="4" style="width:100%;" placeholder="输入提交信息"></textarea>
			<label style="display:flex; gap:6px; align-items:center; margin:8px 0;">
				<input type="checkbox" v-model="pushAfter"> 提交后推送（push）
			</label>
			<button class="confirm_btn" :disabled="busy || !message.trim() || clean" @click="commitWithMessage()">提交</button>
			<span v-if="clean" style="margin-left:10px; color:var(--color-subtle);">工作区干净，无需提交</span>
		</div>
		<div v-else style="color:var(--color-subtle);">请先初始化仓库（状态页右上角按钮）。</div>
	</div>

	<div v-if="page === 'history'">
		<div v-if="hasRepo" style="color:var(--color-subtle); font-size:11px; margin-bottom:6px;">
			点击眼睛图标可在临时分支（temp/preview-*）中检出该提交并作为新标签页打开：当前工程保持最新版本，两个标签页可同时查看对比。预览目录 .bbgit_preview/ 已自动加入 .gitignore。
		</div>
		<div v-if="!hasRepo" style="color:var(--color-subtle);">请先初始化仓库。</div>
		<div v-else-if="history.length === 0" style="color:var(--color-subtle);">暂无提交</div>
		<div v-else style="max-height:340px; overflow-y:auto;">
			<div v-for="h in history" :key="h.hash" style="padding:5px 2px; border-bottom:1px solid var(--color-border);">
				<div style="display:flex; gap:8px; align-items:center; min-width:0;">
					<code style="color:var(--color-accent); flex-shrink:0;">{{ h.hash }}</code>
					<span v-if="previews[h.hash]" style="font-size:10px; color:var(--color-accent); flex-shrink:0;">预览中</span>
					<span style="flex:1; min-width:0; color:var(--color-subtle); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ h.date }}</span>
					<span style="max-width:90px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; color:var(--color-subtle); font-size:11px;">{{ h.author }}</span>
					<div v-if="previews[h.hash]" class="tool" title="打开此预览的工程文件" @click="openPreview(h)"><i class="material-icons">open_in_new</i></div>
					<div v-if="previews[h.hash]" class="tool" title="关闭预览并删除临时分支" @click="closePreviewRow(h)"><i class="material-icons">close</i></div>
					<div v-else class="tool" title="在临时分支中检出此提交（不影响当前工程）" @click="preview(h)"><i class="material-icons">visibility</i></div>
					<div class="tool" title="回退到此提交（git reset --hard）" @click="resetTo(h)"><i class="material-icons">undo</i></div>
				</div>
				<div style="word-break:break-word; padding-top:2px;">{{ h.msg }}</div>
			</div>
		</div>
	</div>

	<div v-if="page === 'settings'" style="display:grid; gap:12px;">
		<div>
			<div style="margin-bottom:4px;">自动提交模式</div>
			<select class="dark_bordered" v-model="s.mode" @change="applySettings()" style="width:100%;">
				<option value="both">保存计数 + 定时</option>
				<option value="count">仅保存计数</option>
				<option value="time">仅定时</option>
				<option value="off">关闭</option>
			</select>
		</div>
		<div style="display:flex; gap:10px;">
			<div style="flex:1;">
				<div style="margin-bottom:4px;">保存次数阈值</div>
				<input type="number" class="dark_bordered" min="1" max="1000" v-model.number="s.saveCount" @change="applySettings()" style="width:100%;">
			</div>
			<div style="flex:1;">
				<div style="margin-bottom:4px;">自动提交间隔（分钟）</div>
				<input type="number" class="dark_bordered" min="1" max="10080" v-model.number="s.interval" @change="applySettings()" style="width:100%;">
			</div>
		</div>
		<label style="display:flex; gap:6px; align-items:center;">
			<input type="checkbox" v-model="s.saveBefore" @change="applySettings()"> 定时提交触发时先自动保存项目
		</label>
		<label style="display:flex; gap:6px; align-items:center;">
			<input type="checkbox" v-model="s.autoPush" @change="applySettings()"> 自动提交后推送（push）
		</label>
		<label style="display:flex; gap:6px; align-items:center;">
			<input type="checkbox" v-model="s.autoConfig" @change="applySettings()"> 打开工程时自动补全 .gitignore / LFS 过滤配置
		</label>
		<div>
			<div style="margin-bottom:4px;">自动提交消息模板</div>
			<input type="text" class="dark_bordered" v-model.trim="s.msgTpl" @change="applySettings()" style="width:100%;">
			<div style="color:var(--color-subtle); font-size:11px; margin-top:3px;">占位符：{date} 日期、{time} 时间</div>
		</div>
		<div>
			<div style="margin-bottom:4px;">LFS 图像扩展名</div>
			<input type="text" class="dark_bordered" v-model.trim="s.lfsExts" @change="applySettings()" style="width:100%;">
			<div style="color:var(--color-subtle); font-size:11px; margin-top:3px;">逗号分隔；初始化仓库与打开工程自动补全时使用</div>
		</div>
		<div>
			<div style="margin-bottom:4px;">git 可执行文件路径</div>
			<input type="text" class="dark_bordered" v-model.trim="s.gitPath" @change="applySettings()" style="width:100%;" placeholder="git">
			<div style="color:var(--color-subtle); font-size:11px; margin-top:3px;">默认使用 PATH 中的 git，也可指定完整路径</div>
		</div>
	</div>
</div>
`
		}
	});
	P.vm = P.panel.vue;
	P.panel.on('fold', () => {
		if (P.panel && !P.panel.folded) refreshPanel();
	});
}

async function refreshPanel() {
		let vm = P.vm;
		if (!vm) return;
		syncVm();
		let st = selectedState() || (Project ? await ensureState(Project) : null);
		if (st) {
			try { await refreshStatus(st); } catch (e) { /* 忽略：无仓库等 */ }
		}
		syncVm();
		if (vm.page === 'history') refreshHistoryPage();
	}

	async function refreshHistoryPage() {
		let vm = P.vm;
		if (!vm) return;
		let st = selectedState();
		if (!st) { vm.history = []; return; }
		vm.history = await refreshHistory(st);
		await refreshPreviews(st).catch(() => {});
	}

// ------------------------------------------------------------------
// 设置
// ------------------------------------------------------------------

function registerSettings() {
	Settings.addCategory('git', { name: 'Git' });
	let defs = [
		['git_auto_commit_mode', {
			type: 'select', value: 'both', category: 'git',
			name: 'Git 自动提交模式',
			description: '保存计数：累计 N 次保存后自动提交；定时：每隔 X 分钟自动提交',
			options: { both: '保存计数 + 定时', count: '仅保存计数', time: '仅定时', off: '关闭' }
		}],
		['git_save_count', {
			type: 'number', value: 10, min: 1, max: 1000, step: 1, category: 'git',
			name: 'Git 自动提交：保存计数阈值',
			description: '累计保存多少次后自动提交'
		}],
		['git_commit_interval', {
			type: 'number', value: 10, min: 1, max: 10080, step: 1, category: 'git',
			name: 'Git 自动提交：间隔（分钟）',
			description: '定时自动提交的间隔分钟数'
		}],
		['git_save_before_timed', {
			type: 'toggle', value: true, category: 'git',
			name: 'Git 定时提交前自动保存项目',
			description: '定时提交触发时先保存当前工程（含贴图），再提交，确保提交内容与工程一致'
		}],
		['git_auto_push', {
			type: 'toggle', value: false, category: 'git',
			name: 'Git 自动提交后推送',
			description: '自动提交成功后执行 git push（需要已配置远程仓库与凭据管理器）'
		}],
		['git_lfs_auto_config', {
			type: 'toggle', value: true, category: 'git',
			name: 'Git 打开工程时自动补全过滤配置',
			description: '打开工程时自动检测仓库的 .gitattributes（LFS 图像追踪）与 .gitignore，缺失的条目自动补全'
		}],
		['git_auto_commit_message', {
			type: 'text', value: '自动 commit {date} {time}', category: 'git',
			name: 'Git 自动提交消息模板',
			description: '占位符：{date} = 日期，{time} = 时间'
		}],
		['git_lfs_extensions', {
			type: 'text', value: LFS_DEFAULT_EXTS, category: 'git',
			name: 'Git LFS 图像扩展名',
			description: '初始化仓库与打开工程自动补全时追踪的图像文件扩展名（逗号分隔）'
		}],
		['git_path', {
			type: 'text', value: 'git', category: 'git',
			name: 'Git 可执行文件路径',
			description: '默认使用 PATH 中的 git；可指定完整路径',
			onChange() { P.gitAvailable = true; }
		}]
	];
	for (let [id, data] of defs) {
		P.settingDefs.push(new Setting(id, data));
	}
}

// ------------------------------------------------------------------
// Action 注册
// ------------------------------------------------------------------

function registerActions() {
	let manager = new Action('blockbench_git_manager', {
		name: 'Git 项目管理',
		description: '打开/关闭 Git 项目管理面板（可悬浮或停靠在界面上）',
		icon: 'account_tree',
		condition: () => !!Project,
		click() { openGitPanel(); }
	});
	MenuBar.addAction(manager, 'file.#save');

	let panelToggle = new Action('blockbench_git_panel', {
		name: 'Git 项目管理',
		description: '打开/关闭 Git 项目管理面板（可悬浮或停靠在界面上）',
		icon: 'account_tree',
		condition: () => !!Project,
		click() { openGitPanel(); }
	});
	Toolbars.main_tools.add(panelToggle);

	let quickCommit = new Action('blockbench_git_commit', {
		name: 'Git 提交全部变更',
		description: '一键提交当前工程的全部变更',
		icon: 'check_circle',
		condition: () => isApp && !!Project && !!Project.save_path,
		click() {
			if (Project && isPreviewPath(Project.save_path)) {
				toast('预览工程不参与 Git 管理');
				return;
			}
			let st = selectedState();
			if (!st) {
				openInitDialog();
				return;
			}
			if (st.busy) return;
			Blockbench.showMessageBox({
				title: '提交全部变更',
				icon: 'check_circle',
				message: `将把 ${st.view.files.length} 个变更文件提交到分支 ${st.view.branch || 'HEAD'}。`,
				buttons: ['提交', '取消'],
				confirmIndex: 0,
				cancelIndex: 1
			}, btn => {
				if (btn === 0) doCommit(st, '手动提交 ' + now());
			});
		}
	});
	Toolbars.main_tools.add(quickCommit);

	P.actions.push(manager, panelToggle, quickCommit);
}

// ------------------------------------------------------------------
// 生命周期
// ------------------------------------------------------------------

function registerEvents() {
	P.events.push(
		Blockbench.on('saved_state_changed', e => { onSavedChanged(e); }),
		Blockbench.on('select_project', e => {
			ensureState(e.project).then(st => {
				if (!st) { syncVm(); return; }
				// 打开/切换工程时自动检测并补全 .gitattributes / .gitignore
				autoConfigGitFilters(st.root).finally(() => {
					refreshStatus(st).catch(() => {});
				});
			});
		}),
		Blockbench.on('close_project', e => {
			let st = P.states.get(e.project.uuid);
			clearTimeout(st && st.timedFailTimer);
			P.states.delete(e.project.uuid);
			syncVm();
		})
	);
}

function onload() {
	if (!isApp) return;
	P.cp = require('child_process');
	registerSettings();
	registerActions();
	registerEvents();
	buildGitPanel();
	P.timer = setInterval(onTimer, 30000);
}

function onunload() {
	clearInterval(P.timer);
	P.timer = null;
	P.events.forEach(e => e.delete());
	P.events = [];
	P.actions.forEach(a => a.delete());
	P.actions = [];
	P.settingDefs.forEach(s => s.delete());
	P.settingDefs = [];
	if (P.panel) {
		P.panel.delete();
		P.panel = null;
		P.vm = null;
	}
	P.states.clear();
}

// 供自动化测试使用（Blockbench 运行环境中 module 未定义，此分支不会执行）
if (typeof module !== 'undefined' && module && module.exports) {
	module.exports.__internals = {
		P, gitRun, findRepoRoot, ensureState, parseStatus, refreshStatus, refreshHistory,
		initRepo, doCommit, doPush, autoCommit, onSavedChanged, onTimer, autoMessage,
		parseExts, ensureLfsAttributes, ensureGitignore, autoConfigGitFilters,
		getRemoteUrl, setRemoteUrl, fetchRemoteGap, resolveUpstreamRef, forcePush, forcePull,
		isPreviewPath, refreshPreviews, previewCommit, openPreviewProject, closePreview,
		onload, onunload, registerSettings, registerActions, registerEvents,
		resetToCommit, discardChanges, openInitDialog, openGitPanel, buildGitPanel, refreshPanel
	};
}

Plugin.register('blockbench_git', {
	title: 'Git Project Manager',
	author: 'blockbench_plugin_git',
	icon: 'account_tree',
	description: '在 Blockbench 内管理工程 Git 仓库：初始化（含 LFS 图像追踪）、提交、推送、回退；支持保存计数与定时自动提交。',
	version: '1.0.0',
	variant: 'desktop',
	min_version: '4.10.0',
	onload,
	onunload
});
