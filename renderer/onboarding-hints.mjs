import { copy } from './copy.mjs';

const descriptions = {
  recover: 'Откройте следующий шаг, чтобы понять причину и продолжить работу.',
  checks: 'Здесь сохранён вывод проверки. По нему видно, что нужно исправить перед повтором.',
  provider: 'Директору нужно рабочее подключение, чтобы подготовить план. Проверьте его в настройках.',
  plan: 'Директор подготовил предложение. Откройте план, чтобы проверить задачи и состав команды.',
  approve: 'Проверьте задачи и команду. Подставьте решение и отправьте его, чтобы поставить спринт в очередь.',
  initialize: 'Директор предложит команду, задачи и порядок работы. Вы согласуете план перед запуском.',
  training: 'Коуч выполняет упражнение и проходит проверку. Зависимые задачи ждут готовности роли.',
  exercise: 'Здесь видно, чему учится агент и прошёл ли он проверку. Рабочий результат появится в задаче проекта.',
  result: 'Отчёты и опубликованные файлы собраны в разделе «Работа → Артефакты».',
  file: 'Нажмите на имя файла, чтобы открыть его. «Показать в папке» открывает место сохранения.',
  report: 'Откройте задачу, чтобы прочитать её отчёт.',
  draft: 'Здесь можно вернуться к сохранённым полям и закончить создание студии.',
  create: 'Укажите, чем будет заниматься студия и где хранить проект. После создания можно запросить план.',
};
const priority = Object.keys(descriptions);

export function selectOnboardingHint({ enabled, surface, targets }) {
  if (!enabled) return null;
  for (const kind of priority) {
    const target = targets.find(item => item.kind === kind && item.visible !== false && !item.disabled);
    if (!target) continue;
    const description = descriptions[target.action === 'checks' ? 'checks' : kind];
    return { key: JSON.stringify([surface, kind, target.id, target.action]), target, description };
  }
  return null;
}

export function createOnboardingHints(document, { disable, reportError, fallbackTarget }) {
  const confirmation = document.querySelector('#onboarding-confirm');
  const panel = document.createElement('aside');
  panel.className = 'onboarding-hint';
  panel.innerHTML = '<span class="onboarding-pointer" aria-hidden="true">↑</span><span id="onboarding-description"></span><button class="onboarding-dismiss" type="button">×</button>';
  const close = panel.querySelector('button');
  const title = confirmation.querySelector('h2');
  const cancel = confirmation.querySelector('[data-hint-cancel]');
  const submit = confirmation.querySelector('[data-hint-disable]');
  const error = confirmation.querySelector('[role=alert]');
  let key;
  let anchor;
  let restoreCloseFocus = false;
  let dismissed = false;
  let saving = false;

  function clearAnchor() {
    if (!anchor) return;
    const descriptions = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== 'onboarding-description');
    if (descriptions.length) anchor.setAttribute('aria-describedby', descriptions.join(' '));
    else anchor.removeAttribute('aria-describedby');
    anchor = undefined;
  }

  function focusAfterDismissal() {
    const target = anchor?.isConnected ? anchor : fallbackTarget?.() ??
      document.querySelector('#dialog[open] h2') ?? document.querySelector('#content h1');
    if (target && !target.matches('button, input, summary, [tabindex]')) target.tabIndex = -1;
    target?.focus({ preventScroll: true });
  }

  close.onclick = () => {
    dismissed = false;
    title.textContent = copy('Отключить подсказки?');
    confirmation.querySelector('.onboarding-confirm-note').textContent = copy('Их можно снова включить в настройках приложения.');
    cancel.textContent = copy('Отмена');
    submit.textContent = copy('Отключить');
    error.hidden = true;
    confirmation.showModal();
    cancel.focus();
  };
  cancel.onclick = () => confirmation.close();
  confirmation.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  confirmation.addEventListener('close', () => {
    if (dismissed || !close.isConnected) focusAfterDismissal();
    else close.focus({ preventScroll:true });
  });
  submit.onclick = async () => {
    if (saving) return;
    saving = true;
    submit.disabled = true;
    cancel.disabled = true;
    try {
      await disable();
      dismissed = true;
      confirmation.close();
    } catch (failure) {
      error.textContent = reportError(failure);
      error.hidden = false;
    } finally {
      saving = false;
      submit.disabled = false;
      cancel.disabled = false;
    }
  };

  return {
    captureFocus() { restoreCloseFocus ||= document.activeElement === close; },
    paint(hint) {
      const nextAnchor = hint?.target.element;
      if (!nextAnchor) {
        clearAnchor();
        panel.remove();
        key = undefined;
        restoreCloseFocus = false;
        return;
      }
      if (anchor !== nextAnchor) {
        clearAnchor();
        anchor = nextAnchor;
        const ids = new Set((anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
        ids.add('onboarding-description');
        anchor.setAttribute('aria-describedby', [...ids].join(' '));
        anchor.after(panel);
      }
      if (hint.key !== key) {
        const pointer = panel.querySelector('.onboarding-pointer');
        pointer.getAnimations().forEach(animation => animation.cancel());
        if (!document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          pointer.animate([{transform:'translateY(0)'},{transform:'translateY(-4px)'},{transform:'translateY(0)'}],
            {duration:850, iterations:3, easing:'ease-in-out'});
        }
      }
      close.setAttribute('aria-label', copy('Отключить подсказки'));
      panel.querySelector('#onboarding-description').textContent = copy(hint.description);
      if (restoreCloseFocus && key === hint.key && !confirmation.open) close.focus({ preventScroll:true });
      restoreCloseFocus = false;
      key = hint.key;
    },
  };
}
