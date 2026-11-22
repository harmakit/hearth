const sections=['Биография','Исторический фон','Внешность','Повседневная жизнь','Сцена','Источники'];
const subjects=['железнодорожница','сельский врач','библиотекарь','фотограф','инженер','редактор'];

export function studioInterfaceFixture() {
  return [{title:'Сверить доступ к источникам',prompt:'Проверить доступность материалов для нового выпуска.'}, ...sections.flatMap(section=>subjects.map(subject=>({
    title:`${section} · ${subject}`,
    prompt:`Подготовить раздел «${section}» для досье.`,
  })))];
}
