import {DatabaseSync} from 'node:sqlite';
export function sqliteD1(sql){
 return {
  prepare(query){const statement=sql.prepare(query);let values=[];return {
   bind(...args){values=args;return this;},
   async run(){const result=statement.run(...values);return {success:true,meta:{changes:Number(result.changes)},results:[]};},
   async all(){return {success:true,results:statement.all(...values)};},
   async first(){return statement.get(...values)??null;}
  };},
  async batch(statements){sql.exec('BEGIN');try{const results=[];for(const statement of statements){if(statement.all)results.push(await statement.all());else results.push(await statement.run());}sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}
 };
}
export {DatabaseSync};
