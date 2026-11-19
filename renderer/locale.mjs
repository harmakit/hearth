export const localeNames = { en:'English', 'zh-Hans':'简体中文', es:'Español', fr:'Français', ru:'Русский' };
export function tokenCount(locale,count) {
  const forms={
    en:{one:'token',other:'tokens'}, es:{one:'token',other:'tokens'}, fr:{one:'jeton',other:'jetons'},
    ru:{one:'токен',few:'токена',many:'токенов',other:'токена'}, 'zh-Hans':{other:'个 token'},
  };
  const words=forms[locale] ?? forms.en;
  const category=new Intl.PluralRules(locale).select(count);
  return new Intl.NumberFormat(locale).format(count)+' '+(words[category] ?? words.other);
}
const locales = Object.keys(localeNames);
const messages = {
 firstWork:['First eligible tasks after training','培训后首批可开始的任务','Primeras tareas disponibles tras la formación','Premières tâches disponibles après la formation','Первые задачи после подготовки команды'],
 newRoles:['Roles to train','需要培训的角色','Roles que requieren formación','Rôles à former','Роли, которым предстоит обучение'],
 missingFolder:['Project folder unavailable','项目文件夹不可用','Carpeta del proyecto no disponible','Dossier du projet indisponible','Папка проекта недоступна'],
 compare:['Compare closed sprints','比较已结束的迭代','Comparar sprints cerrados','Comparer les sprints clos','Сравнить закрытые спринты'],
 completedOfPlanned:['Accepted / planned','已验收 / 计划','Aceptadas / previstas','Validées / prévues','Принято / запланировано'],
 carried:['Carried over','结转','Trasladadas','Reportées','Перенесено'],
 method:['Measurement method','统计方法','Método de cálculo','Méthode de calcul','Методика'],
 more:['Show more','显示更多','Mostrar más','Afficher la suite','Показать ещё'],
 detach:['Disconnect folder','断开文件夹','Desvincular carpeta','Détacher le dossier','Отсоединить папку'],
 detached:['Folder disconnected','文件夹已断开','Carpeta desvinculada','Dossier détaché','Папка отсоединена'],
 detachHint:['Pauses studio work. All project files and the Git repository stay on disk. Select a folder in studio settings to reconnect.','暂停工作室工作。项目文件和 Git 仓库将保留在磁盘上。可在工作室设置中重新连接。','Pausa el trabajo. Los archivos y el repositorio Git se conservan en el disco. Selecciona una carpeta en los ajustes para reconectar.','Suspend le travail. Les fichiers et le dépôt Git restent sur le disque. Choisissez un dossier dans les paramètres pour le reconnecter.','Работа студии приостанавливается. Файлы и Git остаются на диске. Для подключения выберите папку в настройках студии.'],
 findMaterial:['Search saved material by role, title or version','按角色、标题或版本搜索资料','Buscar material por rol, título o versión','Chercher un document par rôle, titre ou version','Найти материал по роли, названию или версии'],
 currentPlan:['Open current version','打开当前版本','Abrir la versión actual','Ouvrir la version actuelle','Открыть актуальную редакцию'],
 archive:['Archive studio','归档工作室','Archivar estudio','Archiver le studio','Архивировать студию'],
 archived:['Archived studios','已归档工作室','Estudios archivados','Studios archivés','Архив студий'],
 restore:['Restore','恢复','Restaurar','Restaurer','Восстановить'],
 archiveHint:['Stops scheduled work and keeps tasks and project files.','暂停计划工作，保留任务和项目文件。','Detiene el trabajo programado y conserva las tareas y los archivos.','Suspend le travail planifié et conserve les tâches et les fichiers.','Останавливает работу по расписанию. Задачи и файлы сохраняются.'],
 findFile:['Find a file, task or author','查找文件、任务或作者','Buscar archivo, tarea o autor','Rechercher un fichier, une tâche ou un auteur','Найти файл, задачу или автора'],
 periodFrom:['From','从','Desde','Du','С даты'],periodTo:['Through','至','Hasta','Au','По дату'],
 team:['Team','团队','Equipo','Équipe','Команда'],map:['Workshop map','工作间布局','Mapa del taller','Plan de l’atelier','Карта мастерской'],
 role:['Role','角色','Rol','Rôle','Роль'],state:['State','状态','Estado','État','Состояние'],
 model:['Model / effort','模型 / 推理强度','Modelo / razonamiento','Modèle / raisonnement','Модель / effort'],
 training:['Training','培训','Formación','Formation','Подготовка'],accepted:['Accepted tasks','已验收任务','Tareas aceptadas','Tâches validées','Принято задач'],
 comment:['Comment','评论','Comentario','Commentaire','Комментарий'],
 postComment:['Add comment','添加评论','Añadir comentario','Ajouter un commentaire','Добавить комментарий'],
 saved:['Saved','已保存','Guardado','Enregistré','Сохранено'],
 latest:['Last change','最近变更','Último cambio','Dernière modification','Последнее изменение'],
 window:['Next work window','下个工作时段','Próximo periodo de trabajo','Prochaine plage de travail','Ближайшее рабочее окно'],
 goal:['Goal','目标','Objetivo','Objectif','Цель'],
 noWork:['Nothing here yet','暂无记录','Todavía no hay registros','Aucune entrée','Записей пока нет'],
 release:['Sprint acceptance','迭代验收','Aceptación del sprint','Validation du sprint','Приёмка спринта'],
 releaseOff:['Only marked tasks','仅标记的任务','Solo tareas marcadas','Tâches marquées uniquement','Только отмеченные задачи'],
 releaseSummary:['Review the final report','验收总结报告','Revisar el informe final','Valider le bilan final','Принять итоговый пакет результатов'],
 releaseHold:['Approve the package before merging to the target','合并到目标分支前验收整个包','Aprobar el paquete antes de fusionarlo','Valider le lot avant la fusion','Удержать слияние всего пакета до подтверждения'],
 members:['Versions in this package','包中的版本','Versiones de este paquete','Versions de ce lot','Версии в этом пакете'],
 roleModel:['Use role settings','使用角色设置','Usar los ajustes del rol','Utiliser les paramètres du rôle','По настройкам роли'],
 override:['Model for this task','此任务使用的模型','Modelo para esta tarea','Modèle pour cette tâche','Модель для этой задачи'],
 previousPlan:['Previous version','上一版','Versión anterior','Version précédente','Предыдущая редакция'],
 changedTasks:['Changed tasks','已变更任务','Tareas modificadas','Tâches modifiées','Изменённые задачи'],
 back:['Back','返回','Atrás','Retour','Назад'],
 close:['Close','关闭','Cerrar','Fermer','Закрыть'],
 width:['Panel width','面板宽度','Ancho del panel','Largeur du panneau','Ширина панели'],
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
