# 安全策略 / Security policy

请勿在公开 Issue 中提交漏洞利用步骤、密钥、个人数据或客户数据。请通过 GitHub 仓库的 **Security → Report a vulnerability** 私密报告；若该入口尚未启用，请先提出不含漏洞细节的联系请求。

Do not post exploit details, credentials, personal information, or customer data in a public issue. Use GitHub **Security → Report a vulnerability** when available. Otherwise request a private contact channel without disclosing details.

生产环境应关闭演示模式，使用 HTTPS 与独立随机密钥。`.env`、数据库快照、上传文件和生产日志不得提交到仓库。
