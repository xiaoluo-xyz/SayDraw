// 工作区分组单测: npm run verify:workspaces
import { findWorkspace, groupSessions, normalizePath, workspaceName } from '../src/shared/workspaces.ts'

let pass = 0
const failures = []
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    failures.push(`${name}: 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`)
    console.log(`FAIL  ${name} — 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`)
  }
}

const s = (id, projectPath, updatedAt, messageCount = 1) => ({ id, title: id, createdAt: 0, updatedAt, messageCount, projectPath })

eq('normalizePath 去尾斜杠', normalizePath('D:\\Art\\键盘\\'), 'D:\\Art\\键盘')
eq('normalizePath 正斜杠统一', normalizePath('D:/Art/键盘'), 'D:\\Art\\键盘')
eq('normalizePath 盘符大写', normalizePath('d:\\art'), 'D:\\art')
eq('workspaceName 末级目录', workspaceName('D:\\Art\\键盘\\'), '键盘')
eq('workspaceName 盘符根', workspaceName('D:\\'), 'D:')

{
  const groups = groupSessions([
    s('a', 'D:\\Art\\键盘', 100),
    s('b', 'D:\\Art\\键盘\\', 300),
    s('c', 'D:\\Art\\猫', 200),
    s('d', undefined, 400),
    s('e', '', 500)
  ])
  eq('工作区数量', groups.workspaces.length, 2)
  eq('独立会话数量(无目录)', groups.loose.length, 2)
  eq(
    '工作区按最近活跃排序',
    groups.workspaces.map((g) => g.name),
    ['键盘', '猫']
  )
  eq('组内按最近活跃排序', groups.workspaces[0].sessions.map((x) => x.id), ['b', 'a'])
  eq('尾斜杠写法合并到同一工作区', groups.workspaces[0].path, 'D:\\Art\\键盘')
  eq('组消息数累加', groups.workspaces[0].messageCount, 2)
  eq('组活跃时间取最大', groups.workspaces[0].updatedAt, 300)
  eq('独立会话排序', groups.loose.map((x) => x.id), ['e', 'd'])
}

{
  const groups = groupSessions([])
  eq('空列表', [groups.workspaces.length, groups.loose.length], [0, 0])
}

{
  const groups = groupSessions([s('a', 'D:\\Art\\键盘', 1), s('b', 'D:\\Art\\猫', 2)])
  eq('findWorkspace 命中', findWorkspace(groups, 'd:/art/键盘/')?.name, '键盘')
  eq('findWorkspace 未命中', findWorkspace(groups, 'D:\\其它'), undefined)
}

console.log(`\n==== ${pass}/${pass + failures.length} 通过 ====`)
if (failures.length) {
  console.log(failures.map((f) => ' - ' + f).join('\n'))
  process.exit(1)
}
