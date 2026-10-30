插件介绍：
本插件为 AI 提供一套基于艾宾浩斯遗忘曲线的长期记忆机制：每条记忆都有强度和可提取度两个指标。强度 S 会随每次复习增长，初始值等于 1 加重要度；可提取度 R 随闲置时间以 exp(-Δt/S) 衰减。检索按“可提取度乘以重要度”排序，被检索命中或主动复习会延长记忆寿命；当一条记忆长时间无人使用、重要度低且从未复习过（R<0.12、重要度≤2、复习次数为 0）时，它会被自动归档，而不是永久堆积。插件提供记住（ebb_add）、检索（ebb_search）、复习（ebb_review）、统计（ebb_stats）、遗忘扫描（ebb_sweep）五个工具，后台每 6 小时自动执行一次归档扫描；所有逻辑都在本地 SQLite 中运行，不调用模型、不依赖向量库或外部服务，因此零 token 成本，并且完全离线。

一，相关参数：
 dbPath默认 ~/.dsh-ebbinghaus/memory.db   SQLite 文件位置
sweepHours后台自动遗忘扫描的间隔,默认(6)h.设为 0 完全关闭自动归档
archiveR归档阈值,默认强度(0.12).低于此可提取度，记忆进入候选归档。(该参数值越大越“健忘”，越小越“念旧”)
archiveImportance记忆归档规则.默认强度(2).记忆重要度≤archiveImportance，则记忆可以被归档
curve默认 exponential  遗忘曲线形状，拥有其它四种函数调节
curveK默认 1.5  形状参数：power 的指数 / logarithmic 的系数 / gaussian 的陡度

归档的三个条件必须同时满足：
可提取度 R < archiveR  且  重要度 ≤ archiveImportance  且  复习次数 = 0
也就是说：重要的不会归档、复习过的不会归档，只有"很久没用又无所谓"的才沉下去.


二，工具：
  ebb_add     记住一条。参数 content（必需）、importance 1-5、tags。
              返回新条目的 id 和初始强度。
  ebb_search  检索。参数 query（必需，中文子串可用）、limit 1-20、includeArchived。
              按 R×重要度 排序，命中即续命。
  ebb_review  复习。参数 id（必需）、quality 1-5。强度按上面的公式增长。
  ebb_stats   看概况：总数、活跃、已归档、平均可提取度、快淡忘的条数、当前曲线。
  ebb_sweep   立刻跑一次遗忘扫描，把该归档的归档。

三，遗忘曲线函数及其核心依据公式
   配置项 curve 选形状，curveK（默认 1.5）选形状参数。
   1. exponential  经典指数遗忘曲线 / Exponential
     公式 R = e^(-x)
     性格 前期掉得快，后期无限逼近 0。最接近教科书里的艾宾浩斯曲线。
     适合 想要"该忘就忘、库保持精简"的场景。默认值。

  2.power        幂律遗忘曲线 / Power-law
     公式 R = (1 + x)^(-k)
     性格 前期比指数慢一点，尾巴很长，永远不会真正归零。
     适合 希望"旧事还能想起个大概"。

  3. hyperbolic   双曲遗忘曲线 / Hyperbolic
     公式 R = 1 / (1 + x)
     性格 最念旧的一种，一年后仍有残余可提取度。
     适合 长期陪伴型角色、需要记住很久以前的事。

  4.logarithmic  对数遗忘曲线 / Logarithmic
     公式 R = 1 / (1 + k · ln(1 + x))
     性格 前期掉得最慢，几乎像"永久记得"。
     适合 只记极少数长期事实（生日、称呼、重要约定）。
     警告 配默认阈值 0.12 等于永不归档，务必同时调高 archiveR。

  5. gaussian     高斯遗忘曲线 / Gaussian
     公式 R = e^(-x² / 2k)
     性格 前面平得像没在忘，过了某个点断崖式下跌，像"硬过期"。
     适合 会话缓存、短期任务备忘这类"到期就该消失"的记忆。

  同 x 下的 R 值对照（k = 1.5）
      x(天/强度)      0     0.5      1      2      4      8
      exponential 1.000   0.607  0.368  0.135  0.018  0.000
      power       1.000   0.544  0.354  0.192  0.089  0.037
      hyperbolic  1.000   0.667  0.500  0.333  0.200  0.111
      logarithmic 1.000   0.622  0.490  0.378  0.293  0.233
      gaussian    1.000   0.920  0.717  0.264  0.005  0.000

  跌到默认归档阈值 R=0.12 需要多少个 x 单位
      exponential  2.14
      gaussian     2.54
      power        3.12
      hyperbolic   7.34
      logarithmic  131.82

  换算成"日历天数"（天数 = x × 强度，强度 = 1 + 重要度），在从未复习的前提下：
      曲线          重要度1   重要度2   重要度3   重要度4   重要度5
      exponential     4 天      6 天      9 天     11 天     13 天
      gaussian        5 天      8 天     10 天     13 天     15 天
      power           6 天      9 天     12 天     16 天     19 天
      hyperbolic     15 天     22 天     29 天     37 天     44 天
      logarithmic   264 天    395 天    527 天    659 天    791 天

  注意：以上是"从未被检索、从未复习"的最快归档时间。实际使用时，只要 ebb_search
  命中一次或 ebb_review 一次，强度变大，归档时间会显著推后。

  R = 曲线函数( x )            x = 闲置天数 / 强度 S        可提取度随时间衰减
  S ← S × 1.8 × f(quality) + 0.5                             复习让记忆更耐久
  初始强度 S0 = 1 + 重要度
x 的直觉：强度 S=4 的记忆，放了 8 天，x=2；强度 S=16 的记忆，放了 8 天，x=0.5，
所以"强度越大，同样的日历时间衰减越慢"。

四，概念调节及其调节方法
   1.初始强度 S0 = 1 + 重要度
   作用 决定新记忆一开始有多耐久。重要度 5 的强度是重要度 1 的 3 倍。
   调用时调 ebb_add 的 importance 参数（1-5，默认 3）：
    重要度 1 → S0 = 2      重要度 3 → S0 = 4      重要度 5 → S0 = 6
    想整体更牢/更松 改代码常量 S0（lib/index.js 里 `const strength = 1 + importance`），
   例如改成 `2 + importance * 2`，改完必须重新部署并重启 DSH。

    2.复习增益 S ← S × 1.8 × f(quality) + 0.5
   作用 每次复习让强度增长的倍率。1.8 越大，复习一次管得越久。
    现状 复习一次 quality=4 时约 ×1.44 再加 0.5；quality=5 时约 ×1.62 再加 0.5。
    实测 S 从 5.00 → 16.70（quality=5）。
    调用时调 ebb_review 的 quality 参数（1-5）。
    想改倍率 修改 lib/index.js 里的 1.8（以及 +0.5 那个偏移量）。

    3.质量系数 f(quality) = 0.8 + 0.2 × quality
    作用 把"这次复习有多确信"折算成倍率修正。
      quality 1 → f=1.0（勉强想起，增益最小）
      quality 3 → f=1.4
      quality 5 → f=1.8（完全确信，增益最大）
      调用时调 ebb_review 的 quality 参数，不需要改代码。
      想改映射曲线 修改 lib/index.js 里的 `const factor = 0.8 + q * 0.2`。

      4.强度下限 S ≥ 0.5
      作用 防止强度被算成极小值（或历史脏数据为 0）导致 R 瞬间归零。
      任何记忆的有效强度至少按 0.5 计算。
      调节 修改 lib/index.js 里 `Math.max(0.5, Number(row.strength ?? 1))` 的 0.5。
      调大 → 衰减更慢、更不容易归档；调小 → 衰减更陡。

      5.检索排序 score = R × 重要度
      作用 ebb_search 的排序依据。先按"此刻还记得多少"，再乘重要度，
       让"既记得又重要"的排在前面。每条命中还会自动续命（use_count+1、
       刷新 last_used_at），被检索到本身就是一次弱复习（不改强度）。
      调用时调 ebb_search 的 limit（1-20，默认 5）与 includeArchived
     （默认 false，即已归档的搜不到）。
      想改权重 修改 lib/index.js 里 `.map((r) => ({ ...r, score: r.R * (Number(r.importance) || 3) }))`：
       只按可提取度      → r.R
       更看重重要度      → r.R * Math.pow(r.importance, 2)
       重要度只是微调    → r.R * (1 + r.importance * 0.1)

 五， 常见坑：
     用 PowerShell 5.1 的 Set-Content -Encoding UTF8 写 package.json 会带 BOM，
     DSH 的 JSON.parse 会直接崩在启动阶段。要写 JSON 请用
     [System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))
     dsh plugin add/remove 可能重写 profile 的 bundles 清单并丢掉手工加的条目，
     改清单后要核对 dsh.profile.bundles 是否完整。
     改了源码却忘了复制到 node_modules 的运行目录，重启后行为不会变。

使用方法
1.解压dsh-ebbinghaus-0.1.0.zip
2.运行powershell -ExecutionPolicy Bypass -File .\install.ps1