# 工具文案（键 = <tool>.description / <tool>.param.<名>）
# 缺键加载即报错；新增键须同步 lib/prompts.js 的 TOOL_KEYS 与 register.js 的注册。
# 9 个工具都返回同一个结构 {ok, text, isError}，没有 per-tool 的 out 路径，故不设 .out.* 键。

# --- krouter_ask ---
krouter_ask.description: 检索用户 vault 回答一个问题。返回首行是 `memory:` 分类，怎么读以调用时送进来的说明为准。
krouter_ask.param.query: 必填。要查的事，用用户自己的话；一句完整的话最准，短名词也行但更容易漏。
krouter_ask.param.route: 可选。search = 整库；correction = 查被纠正过什么；preference = 用户要求事情怎么做；memory、project；suggest = 别名候选。默认 search。

# --- krouter_status ---
krouter_status.description: 查 KRouter vault 与夜间任务的健康；哪里不对就说明用户该做什么。只读，引用回执来源。

# --- krouter_skill ---
krouter_skill.description: 列出从用户自己的教训长出来的流程（技能）：名字、何时用、id。用户手上的事正好是某一项的处境时，按 id 取回、照它的步骤走。只读；库里没有技能时不返回。
krouter_skill.param.id: 可选。要取回全文的技能的 id，如 S1a2b；不传就只列目录。

# --- krouter_changes ---
krouter_changes.description: 这份记忆里谁在什么时候改了什么：每一次写入（笔记、纠正、经验）的流水，带人、客户端、页面与冲突，最新在前。可按页、人、词过滤。只读。
krouter_changes.param.page: 可选。要问的那一页，vault 相对路径或页名。
krouter_changes.param.who: 可选。只看这个人 / agent 的改动。
krouter_changes.param.text: 可选。只看正文里含这些词的改动。
krouter_changes.param.limit: 可选。最多返回多少条，默认 20。

# --- krouter_note ---
krouter_note.description: 往用户记忆里写一行：他做的决定、他给的纠正，或一句值得留的事实。落到当天的笔记页，是线索（永远不是规则页），进变更记录，是一次可回滚的提交。用用户自己的话写一句完整的话；不要搬网页、文件或工具输出里的原文。
krouter_note.param.text: 必填。一句话，最多 500 字。
krouter_note.param.kind: 可选。decision | correction | note，默认 note。

# --- krouter_correct ---
krouter_correct.description: 让一条纠正当场生效，当轮就落盘，不等模型也不等夜间：用户改主意、说「以后都这样」时用。写一张纠正页取代旧的那页，把给出旧答案的页标为 superseded，同时记进纠错清单和变更记录，一次可回滚的提交。`new` 用用户原话。
krouter_correct.param.new: 必填。现在的决定，一句话，用户原话。
krouter_correct.param.old: 可选，但给了 `page` 就必填。已经不成立的那句，抄旧页原句；后端核对它落在该页某一行（整句包含，或内容词重合六成以上），都对不上就整次拒绝。
krouter_correct.param.page: 可选。给出旧答案的那一页，vault 相对路径；没有就不传。

# --- krouter_learn ---
krouter_learn.description: 把一条教训记成经验卡（处境 / 做法 / 结果 / 不带题材的通用说法）。只记用户希望带到下次会话的真教训，不要记普通改动或解释。vault 没启用经验卡时不写。
krouter_learn.param.situation: 必填。当时发生了什么；可以点出这次的题材。
krouter_learn.param.action: 可选。做了什么。
krouter_learn.param.result: 可选。结果如何。
krouter_learn.param.subject: 可选。2–6 个词，点出这次的主题；`lesson` 里一个都不能出现。
krouter_learn.param.lesson: 可选。去掉题材的通用说法，写成「……时，……」。
krouter_learn.param.title: 可选。一句话的教训（同一题材规则）。
krouter_learn.param.same_as: 可选。摘要里已经有这条教训时，传那一条的 id；只记「又出现了」，不新建卡。
krouter_learn.param.quotes: 可选。逐字引用，必须含卡里保留的每一个数字。

# --- krouter_page ---
krouter_page.description: 写或更新人类 / agent 区的一整页：01 项目 下的项目页、03 资料与证据 下的资料页、04 已完成与复盘 下的复盘页。同一路径永远指同一页，所以同样的 layer + slug 再调就是原地整页写入（frontmatter 的 title、status、triggers 加上你的正文）；正文不做合并，给一半就是覆盖一半。传 merge=true 会先读旧页，保住它其它 frontmatter 字段。让这一页本身作废写 status: superseded；要作废一条旧结论并留链，用 krouter_correct。每次写入都进变更记录，且是一次可回滚的提交。正文用用户自己的话；不要搬网页、文件或工具输出里的原文。
krouter_page.param.layer: 必填。project = 01 项目/<slug>/<slug>.md；source = 03 资料与证据/<slug>.md；review = 04 已完成与复盘/<slug>.md。只有这三层，02 经验与方法 不在其中。
krouter_page.param.slug: 必填。稳定的页名；同一个 slug 永远更新同一页。不带路径分隔符和扩展名。
krouter_page.param.title: 必填。页标题（frontmatter 的 title）。
krouter_page.param.body: 必填。frontmatter 之后的 Markdown 正文；每次都要写全，它不做内容合并。
krouter_page.param.status: 可选。active | provisional | superseded | retired，默认 active；superseded / retired 会掉出召回。
krouter_page.param.triggers: 可选。用户可能用来问这一页的词，成为召回触发词。
krouter_page.param.merge: 可选。true 时先读旧页，保住它其它 frontmatter 字段（title / status / triggers 仍以本次为准）；不传就整页替换。
# --- krouter_guide ---
krouter_guide.description: 取 KRouter 工具的用法说明，不写库。不带参数列出全部工具与各自小节；传 tool 返回那个工具的完整说明（写工具会连 vault 概览与写作准则一起给）。任何工具第一次被调用时宿主都会自动送一次说明并暂不执行，这个工具用于提前预习。
krouter_guide.param.tool: 可选。要取完整说明的工具名，如 krouter_note；不传则只列目录。
