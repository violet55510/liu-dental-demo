/* =========================================================
   刘氏口腔 · 站点配置（唯一数据源）
   ---------------------------------------------------------
   约定：
   - 空字符串 "" 或 null 表示「待填充」，渲染时会显式标注出来
   - 修改电话 / 地址 / 邮箱 / 营业时间 / 医师 / 诊疗项目，只改本文件
   - 本文件用 window.SITE_DATA 挂载，无需服务器即可用 file:// 打开
   ========================================================= */
window.SITE_DATA = {
  clinic: {
    name: '刘氏口腔',
    nameEn: "Liu's Dental · Yuelu",

    phone: {
      display: '0731-8888 0000',   // 页面显示的号码
      tel: '073188880000'          // tel: 链接用的号码（纯数字）
    },

    email: {
      address: 'info@example.com', // 待填充：替换为门诊实际对外邮箱
      note: '邮箱为占位示例，工作日 1–2 天内回复'
    },

    address: {
      city: '长沙市岳麓区',
      line1: '×× 路 ×× 号 ×× 栋 2 层', // 待填充：街道、门牌、楼层
      note: '详细地址待填充'
    },

    wechat: {
      label: '微信公众号',
      qr: '',                      // 待填充：二维码图片路径，留空显示占位块
      note: '扫码查看门诊公告与出诊安排'
    },

    /* 资质与证照：医生团队页「资质与环境」区块的数据源
       - label     列表里的分类名（机构资质 / 医师资质）
       - title     证照全称，渲染时加书名号
       - summary   证照说明，渲染在名称之后
       - noLabel   证号字段的叫法（证号 / 证书编号）
       - no        '' → 渲染「待填充」；填了才会显示真实编号
       - image     '' → 渲染虚线扫描件占位；填了显示图片
       - imageNote 占位块里的说明文字
       - icon      占位图标：'doc' 证照 / 'person' 个人证书 */
    licenses: [
      {
        id: 'institution',
        label: '机构资质',
        title: '医疗机构执业许可证',
        summary: '公示于前台，诊疗科目含口腔科',
        noLabel: '证号',
        no: '',                    // 待填充：医疗机构执业许可证登记号
        image: '',                 // 待填充：许可证扫描件路径
        imageNote: '扫描件待补充',
        icon: 'doc'
      },
      {
        id: 'practitioner',
        label: '医师资质',
        title: '医师执业证书',
        summary: '四位主诊医师均持有，执业信息与职称可现场查验',
        noLabel: '证书编号',
        no: '',                    // 待填充：医师执业证书编号
        image: '',                 // 待填充：医师执业证书扫描件路径
        imageNote: '扫描件待补充',
        icon: 'person'
      }
    ],

    /* 营业时间：7 天逐日配置；weekday 0 = 周日 */
    hours: {
      holidayNote: '节假日安排以门诊公告为准',
      caption: '常规门诊 09:00 – 20:00，午间不休息',
      days: [
        { weekday: 1, label: '周一', open: '09:00', close: '20:00', note: '正常接诊' },
        { weekday: 2, label: '周二', open: '09:00', close: '20:00', note: '正常接诊' },
        { weekday: 3, label: '周三', open: '09:00', close: '20:00', note: '正常接诊' },
        { weekday: 4, label: '周四', open: '09:00', close: '20:00', note: '正常接诊' },
        { weekday: 5, label: '周五', open: '09:00', close: '20:00', note: '正常接诊' },
        { weekday: 6, label: '周六', open: '09:00', close: '20:00', note: '建议提前预约' },
        { weekday: 0, label: '周日', open: '09:00', close: '20:00', note: '建议提前预约' }
      ]
    },

    demoNotice: '本站为系统设计与学习用演示站点，非真实医疗机构'
  },

  /* 医师列表
     - photo: '' → 渲染头像占位（姓氏首字 + 「照片待填充」）
     - license: '' → 渲染「执业医师证书编号 待填充」
     - years / schedule 上的 pending 标记示例数据 */
  doctors: [
    {
      id: 'liu-implant',
      name: '刘主任',
      dept: '种植科',
      title: '主任医师',
      years: '19 年',
      yearsPending: true,
      license: '',
      schedule: '周一、周三、周五全天',
      schedulePending: true,
      photo: '',
      intro: '单颗、多颗牙缺失的种植修复，全口与半口无牙颌的方案设计，以及骨量不足时的骨增量手术。',
      shortIntro: '擅长单颗 / 多颗牙缺失的种植修复，全口无牙颌种植方案设计。',
      tags: ['种植牙', '全口修复', '骨增量'],
      services: ['implant']
    },
    {
      id: 'liu-ortho',
      name: '刘医生',
      dept: '正畸科',
      title: '主治医师',
      years: '13 年',
      yearsPending: true,
      license: '',
      schedule: '周二、周四、周六全天',
      schedulePending: true,
      photo: '',
      intro: '青少年固定矫正与成人隐形矫正，混合牙列期的早期干预，方案设计兼顾咬合功能与面部协调。',
      shortIntro: '成人隐形矫正与青少年固定矫正，注重咬合功能与面部协调。',
      tags: ['隐形矫正', '青少年正畸', '早期干预'],
      services: ['ortho']
    },
    {
      id: 'liu-general',
      name: '刘医生',
      dept: '综合与牙周',
      title: '主治医师',
      years: '11 年',
      yearsPending: true,
      license: '',
      schedule: '周一至周五下午',
      schedulePending: true,
      photo: '',
      intro: '洗牙、补牙、拔牙与根管治疗，牙周基础治疗与长期维护，同时承担种植、矫正前的基础治疗。',
      shortIntro: '龋病治疗、牙周维护与美学修复，承担种植与正畸的前期基础治疗。',
      tags: ['牙周治疗', '根管治疗', '拔牙'],
      services: ['cleaning', 'filling', 'extraction', 'rct', 'perio']
    },
    {
      id: 'liu-kid',
      name: '刘医生',
      dept: '儿童齿科',
      title: '主治医师',
      years: '8 年',
      yearsPending: true,
      license: '',
      schedule: '周三至周日全天',
      schedulePending: true,
      photo: '',
      intro: '涂氟、窝沟封闭与乳牙治疗，儿童就诊行为引导，替牙期的咬合观察与早期矫治评估。',
      shortIntro: '涂氟、窝沟封闭与乳牙治疗，儿童就诊行为引导。',
      tags: ['儿童齿科', '涂氟封闭', '行为引导'],
      services: ['kids']
    }
  ],

  /* 诊疗项目：与 services.html 的六项 + 种植、矫正对齐
     doctors 字段用于预约页「医师擅长项」联动。

     ★ 价格数据的唯一来源就是这里（第六期统一）★
     - amount_cents：服务端计费用的演示金额，整数「分」。改这里 = 改计价，
       server/pricing.js 启动时读取本文件并校验，服务页的区间也由本文件渲染。
     - price_range：只在服务页展示区间的项目才需要（目前只有种植牙）。
       必须在条目内与 amount_cents 自洽：min ≤ amount ≤ max，
       服务端启动时会校验，不自洽直接拒绝启动。
     - desc：「小程序端」服务列表与详情用的简介（第七期新增）。
       services.html 里的长文案是给人读的段落，这里是 1–2 句摘要，
       两者措辞不同但事实一致；价格始终只认上面两个字段。
     - 金额均为演示数据，不是报价，也不构成任何承诺。 */
  services: [
    {
      id: 'implant', label: '种植牙', doctors: ['liu-implant'],
      desc: '在缺牙位置的牙槽骨内植入种植体，稳定后安装牙冠，不用磨小两侧健康牙。是否适合需术前影像与骨量评估。',
      amount_cents: 680000,
      price_range: {
        min_cents: 600000,
        max_cents: 1500000,
        label: '单颗种植（含种植体、基台与牙冠）',
        unit: '颗',
        note: '参考区间，非最终报价'
      }
    },
    {
      id: 'ortho', label: '牙齿矫正', doctors: ['liu-ortho'],
      desc: '通过矫治器逐步移动牙齿，改善排列与咬合。先拍片取模分析，再决定固定还是隐形方案。',
      amount_cents: 1280000
    },
    {
      id: 'cleaning', label: '洗牙', doctors: ['liu-general'],
      desc: '超声波洁治加抛光，去除牙结石与色素沉着，建议每 6–12 个月做一次。',
      amount_cents: 28000
    },
    {
      id: 'filling', label: '补牙', doctors: ['liu-general'],
      desc: '用树脂材料充填龋洞，尽量保留健康牙体组织；发现得早，处理起来更简单。',
      amount_cents: 38000
    },
    {
      id: 'extraction', label: '拔牙', doctors: ['liu-general'],
      desc: '普通牙与阻生智齿的拔除，术前用影像确认牙根形态与邻近结构。',
      amount_cents: 45000
    },
    {
      id: 'rct', label: '根管治疗', doctors: ['liu-general'],
      desc: '针对牙髓炎、根尖周炎做根管清理与充填，目的是尽量保住这颗天然牙。',
      amount_cents: 98000
    },
    {
      id: 'perio', label: '牙周治疗', doctors: ['liu-general'],
      desc: '龈下刮治与牙周维护，控制牙龈出血与牙齿松动，也是种植、矫正前的必要准备。',
      amount_cents: 68000
    },
    {
      id: 'kids', label: '儿童齿科', doctors: ['liu-kid'],
      desc: '涂氟、窝沟封闭、乳牙治疗与早期咬合干预，也帮孩子慢慢适应看牙。',
      amount_cents: 26000
    }
  ]
};
