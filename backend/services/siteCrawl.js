const { client } = require('./dataforseo');

// DataForSEO's on_page/pages is paginated; this is comfortably above what a
// Pro/Agency crawl (capped at a few hundred pages) needs in one page of results.
const PAGE_LIMIT = 100;

async function startCrawl(domain, maxPages) {
  const { data } = await client.post('/on_page/task_post', [
    { target: domain, max_crawl_pages: maxPages, enable_javascript: true },
  ]);
  const taskId = data.tasks?.[0]?.id;
  if (!taskId) throw new Error('DataForSEO did not return a crawl task id');
  return taskId;
}

async function pollCrawlStatus(taskId) {
  const { data } = await client.get('/on_page/tasks_ready');
  const readyTasks = data.tasks?.[0]?.result ?? [];
  return readyTasks.some((task) => String(task.id) === String(taskId));
}

async function fetchCrawlResults(taskId) {
  const pages = [];
  let offset = 0;

  while (true) {
    const { data } = await client.post('/on_page/pages', [{ id: taskId, limit: PAGE_LIMIT, offset }]);
    const result = data.tasks?.[0]?.result?.[0];
    const items = result?.items ?? [];
    pages.push(...items);
    offset += items.length;

    const totalCount = result?.total_items_count;
    if (items.length === 0 || items.length < PAGE_LIMIT || (totalCount != null && offset >= totalCount)) break;
  }

  return pages;
}

async function fetchLinks(taskId) {
  const links = [];
  let offset = 0;

  while (true) {
    const { data } = await client.post('/on_page/links', [{ id: taskId, limit: PAGE_LIMIT, offset }]);
    const result = data.tasks?.[0]?.result?.[0];
    const items = result?.items ?? [];
    links.push(...items);
    offset += items.length;

    const totalCount = result?.total_items_count;
    if (items.length === 0 || items.length < PAGE_LIMIT || (totalCount != null && offset >= totalCount)) break;
  }

  return links;
}

module.exports = { startCrawl, pollCrawlStatus, fetchCrawlResults, fetchLinks, PAGE_LIMIT };
