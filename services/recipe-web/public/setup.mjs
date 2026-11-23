const kinds = {
  config: { label: '额外配置', title: '连接反馈表', instructions: '说明在哪里选择反馈表，以及使用者需要什么权限。' },
  tool: { label: '工具', title: '安装 Git', instructions: '写明需要的工具、版本和安装来源。' },
  context: { label: '资料或代码', title: '准备项目代码', instructions: '写明仓库地址、分支和需要的文件。有本地副本时，可以直接选用。' },
};

function element(tag, value) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
}

export function setupList(steps) {
  const list = element('ol');
  list.className = 'setup-list';
  for (const step of steps) {
    const item = element('li');
    const title = element('strong', step.title);
    const meta = element('small', kinds[step.kind].label + (step.required ? ' · 必需' : ' · 可选'));
    item.append(title, meta, element('p', step.instructions));
    if (step.check) item.append(element('p', '完成标志：' + step.check));
    list.append(item);
  }
  return list;
}

export function setupEditor(container, add, changed) {
  const encoding = new TextEncoder();
  function field(name, row) { return row.querySelector('[data-field="' + name + '"]'); }
  function refresh() {
    for (const [i, row] of [...container.children].entries()) {
      row.querySelector('legend').textContent = '步骤 ' + (i + 1);
      row.querySelector('[data-move]').hidden = i === 0;
    }
    add.hidden = container.childElementCount >= 8;
  }
  function append(step = {kind: 'config', required: true}) {
    const row = document.getElementById('setup-fields').content.firstElementChild.cloneNode(true);
    for (const name of ['kind', 'title', 'instructions', 'check']) field(name, row).value = step[name] ?? '';
    field('required', row).checked = step.required;
    const kind = field('kind', row);
    function suggest() {
      field('title', row).placeholder = '例如：' + kinds[kind.value].title;
      field('instructions', row).placeholder = kinds[kind.value].instructions;
    }
    suggest();
    kind.addEventListener('change', suggest);
    row.querySelector('[data-remove]').onclick = () => {
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove(); refresh(); changed(); (next ? field('title', next) : add).focus();
    };
    row.querySelector('[data-move]').onclick = () => {
      if (row.previousElementSibling) container.insertBefore(row, row.previousElementSibling);
      refresh(); changed(); field('title', row).focus();
    };
    container.append(row);
    return row;
  }
  add.onclick = () => {
    if (container.childElementCount >= 8) return;
    const row = append(); refresh(); changed(); field('kind', row).focus();
  };
  return {
    load(steps = []) {
      container.replaceChildren(); steps.forEach(step => append(step)); refresh();
    },
    read(publishing = false) {
      const steps = [];
      for (const [i, row] of [...container.children].entries()) {
        const step = {kind: field('kind', row).value, required: field('required', row).checked};
        for (const [name, limit, label] of [['title',80,'名称'],['instructions',2048,'操作说明'],['check',512,'完成标志']]) {
          const control = field(name, row);
          const value = control.value.trim();
          const length = name === 'title' ? [...value].length : encoding.encode(value).length;
          let message;
          if (length > limit) message = label + '太长，请缩短后再保存。';
          else if (!value && publishing && name !== 'check') message = '发布前请填写' + label + '。';
          if (message) {
            const error = new Error('步骤 ' + (i + 1) + '：' + message);
            error.control = control;
            throw error;
          }
          if (value || name !== 'check') step[name] = value;
        }
        steps.push(step);
      }
      return steps.length ? {steps} : undefined;
    },
    control(i, name) {
      const row = container.children[i]; return row && field(name, row);
    },
  };
}
