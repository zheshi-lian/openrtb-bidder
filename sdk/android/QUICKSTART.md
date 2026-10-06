# SDK 上 GitHub 自动出包 · 手把手

> 目标：把本目录做成一个 **GitHub Repository**，以后只要 `git push`，云端自动编译出 `applink-adsdk-release.aar`。
> 你**不需要**在电脑上装 Android Studio / Android SDK / Gradle。

## 第 1 步：在 github.com 上建仓库（建 Repository，不是 Issue / Codespace）
1. 打开 https://github.com/new
2. Repository name 填：`applink-adsdk`（随意，别用中文/空格）
3. 选 **Public**（私有也行，Actions 免费额度内可用）
4. 勾不勾 "Add a README" 都行——本目录已有文件，**建议不勾**，避免冲突
5. 点 **Create repository**

## 第 2 步：在本机把代码推上去
打开终端，**进入本目录**（就是 `sdk/android` 这个文件夹），依次执行：

```powershell
# 1) 初始化仓库（仅首次）
git init
git branch -M main

# 2) 暂存并提交（注意最后有个点，表示当前目录）
git add .
git commit -m "init: AppLink ADX Android SDK"

# 3) 关联远程仓库（把 YOUR_USER 换成你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_USER/applink-adsdk.git

# 4) 首次推送
git push -u origin main
```

> 若提示登录：GitHub 现在用 **Personal Access Token (PAT)** 当密码。
> 生成地址：https://github.com/settings/tokens （勾 `repo` 权限），复制后粘贴到密码框。

## 第 3 步：拿 AAR（两种方式）

### 方式 A：直接下载（开发时用）
1. 进入你的仓库 → 点顶部 **Actions** 标签
2. 点最新一次运行（绿色对勾）→ 底部 **Artifacts** → 下载 `applink-adsdk-aar`
3. 解压得到 `applink-adsdk-release.aar`

### 方式 B：打版本标签（正式发布，挂在 Releases）
```powershell
git tag v1.0.0
git push origin v1.0.0
```
推送后回到仓库 → **Releases** 页会自动出现 `v1.0.0`，里面附带 `applink-adsdk-release.aar`。

## 第 4 步：以后每次改完代码自动出包
```powershell
git add .
git commit -m "feat: xxx"
git push
# 再去 Actions 下载最新 AAR 即可
```

## 常见问题
- **推送报 `remote: Repository not found`**：仓库名/用户名写错，或仓库是 Private 但 PAT 没 `repo` 权限。
- **Actions 红了对号**：点进去看日志，多半是 Android SDK 包没装全；本工作流已固定装 `platforms;android-34`，一般无需改。
- **想本地编译**：需自备 JDK17 + Android SDK + Gradle，详见 `README.md`「本地出包」。
