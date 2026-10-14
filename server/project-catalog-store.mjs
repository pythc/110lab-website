import {z} from 'zod';
const category=z.object({id:z.uuid(),name:z.string().trim().min(1).max(80).refine(v=>!/[\u0000-\u001f\u007f]/u.test(v))}).strict();
const feed=z.object({categories:z.array(category).max(1000)}).strict();
const emptyLinks={repository:'',requirements:'',docs:'',demo:''};
export function projectCatalogStore(db,{now=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS requirement_project_origin(
    project_id TEXT PRIMARY KEY REFERENCES projects(id),category_id TEXT UNIQUE,
    aliases_json TEXT NOT NULL DEFAULT '[]',unconfigured INTEGER NOT NULL DEFAULT 0
  ) STRICT`);
  return {
    info(id){const r=db.prepare('SELECT * FROM requirement_project_origin WHERE project_id=?').get(id);return r?{unconfigured:!!r.unconfigured,aliases:JSON.parse(r.aliases_json)}:{unconfigured:false,aliases:[]};},
    renamed(id,name){
      const row=db.prepare('SELECT name FROM projects WHERE id=?').get(id);if(!row||row.name===name)return;
      const aliases=this.info(id).aliases;
      if(!aliases.includes(row.name))aliases.push(row.name);
      if(aliases.length>200)throw new Error('Project rename history is full');
      db.prepare(`INSERT INTO requirement_project_origin(project_id,aliases_json) VALUES(?,?)
        ON CONFLICT(project_id) DO UPDATE SET aliases_json=excluded.aliases_json`).run(id,JSON.stringify(aliases));
    },
    claim(id){return db.prepare('UPDATE requirement_project_origin SET unconfigured=0 WHERE project_id=? AND unconfigured=1').run(id).changes===1;},
    import(value){
      const {categories}=feed.parse(value),ids=new Set(categories.map(c=>c.id));
      if(ids.size!==categories.length)throw new Error('Duplicate category IDs');
      db.exec('SAVEPOINT import_categories');
      try {
        for(const c of categories){
          // The feed's UUID is stable across retries; never merge unrelated projects by name.
          const origin=db.prepare('SELECT * FROM requirement_project_origin WHERE category_id=?').get(c.id);
          const target=db.prepare('SELECT * FROM projects WHERE id=?').get(origin?.project_id||c.id);
          if(target){
            if(!origin)continue;
            if(origin.unconfigured&&target.name!==c.name){
              this.renamed(target.id,c.name);
              db.prepare('UPDATE projects SET name=?,revision=revision+1,updated_at=? WHERE id=?').run(c.name,new Date(now()).toISOString(),target.id);
            }
            continue;
          }
          if(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n>=1000)throw new Error('Project catalog is full');
          const at=new Date(now()).toISOString();
          db.prepare(`INSERT INTO projects(id,name,summary,owner_subject,owner_name,owner_email,members_json,links_json,phase,created_at,updated_at)
            VALUES(?,?,'','','','','[]',?,'exploring',?,?)`).run(c.id,c.name,JSON.stringify(emptyLinks),at,at);
          db.prepare('INSERT INTO requirement_project_origin(project_id,category_id,aliases_json,unconfigured) VALUES(?,?,?,1)').run(c.id,c.id,JSON.stringify([c.name]));
        }
        db.exec('RELEASE import_categories');
      }catch(e){db.exec('ROLLBACK TO import_categories');db.exec('RELEASE import_categories');throw e;}
    },
  };
}
