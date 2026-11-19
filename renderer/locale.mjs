export const localeNames = { en:'English', 'zh-Hans':'简体中文', es:'Español', fr:'Français', ru:'Русский' };
const locales = Object.keys(localeNames);
const messages = {
 workspace:['All studios','所有工作室','Estudios','Tous les studios','Все студии'],
 'app-settings':['Application settings','应用设置','Ajustes de la aplicación','Paramètres de l’application','Настройки приложения'],
 overview:['Overview','概览','Resumen','Vue d’ensemble','Обзор'],
 work:['Work','工作','Trabajo','Travail','Работа'],
 inbox:['Inbox','收件箱','Bandeja de entrada','Boîte de réception','Входящие'],
 workshop:['Workshop','工作间','Taller','Atelier','Мастерская'],
 skills:['Library','资料库','Biblioteca','Bibliothèque','Библиотека'],
 settings:['Studio settings','工作室设置','Ajustes del estudio','Paramètres du studio','Настройки студии'],
 language:['Interface language','界面语言','Idioma de la interfaz','Langue de l’interface','Язык интерфейса'],
 studio:['Studio','工作室','Estudio','Studio','Студия'],
 newStudio:['New studio','新建工作室','Nuevo estudio','Nouveau studio','Новая студия'],
 create:['Create studio','创建工作室','Crear estudio','Créer un studio','Создать студию'],
 empty:['No studios yet','还没有工作室','Aún no hay estudios','Aucun studio pour le moment','Студий пока нет'],
 start:['Describe the result you want and choose a project folder.','描述预期成果并选择项目文件夹。','Describe el resultado que buscas y elige una carpeta.','Décrivez le résultat attendu et choisissez un dossier.','Опишите нужный результат и выберите папку проекта.'],
 studios:['Studios','工作室','Estudios','Studios','Студии'],
 running:['Tasks in progress','进行中的任务','Tareas en curso','Tâches en cours','Задачи в работе'],
 open:['Open inbox items','待处理事项','Mensajes pendientes','Demandes ouvertes','Открытые входящие'],
 openInbox:['Open inbox','打开收件箱','Abrir bandeja de entrada','Ouvrir la boîte de réception','Открыть входящие'],
 draft:['Draft','草稿','Borrador','Brouillon','Черновик'],
 planning:['Preparing the plan','正在准备计划','Preparando el plan','Préparation du plan','Готовит план'],
 'awaiting-approval':['Awaiting approval','等待批准','Pendiente de aprobación','En attente de validation','Ждёт согласования'],
 active:['Working','工作中','En curso','En activité','В работе'],
 paused:['Paused','已暂停','En pausa','En pause','На паузе'],
 idle:['No active tasks','没有进行中的任务','Sin tareas activas','Aucune tâche active','Без активных задач'],
 error:['Needs attention','需要关注','Requiere atención','À vérifier','Нужно внимание'],
 stopped:['Stopped','已停止','Detenido','Arrêté','Остановлена'],
 inherited:['Use application language','使用应用语言','Usar el idioma de la aplicación','Utiliser la langue de l’application','Как в приложении'],
 general:['Shared settings for all studios','所有工作室的通用设置','Ajustes comunes a todos los estudios','Paramètres communs à tous les studios','Общие параметры для всех студий'],
};
export function textFor(locale, key) {
 const translations = messages[key];
 if (!translations) throw new Error('Unknown interface message: '+key);
 const index = locales.indexOf(locale);
 return translations[index < 0 ? 0 : index];
}
