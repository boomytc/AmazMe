"""The common decision journal retains foreign keys to both real effect owners."""

import sqlite3

import pytest

from amazme_backend.supervisor import ensure_resolution_schema


def test_current_native_receipts_survive_the_atomic_schema_change():
    with sqlite3.connect(':memory:',isolation_level=None) as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('CREATE TABLE scopes(id TEXT PRIMARY KEY)')
        db.execute('CREATE TABLE plugin_calls(id TEXT PRIMARY KEY,step_id TEXT)')
        db.execute('CREATE TABLE code_runs(id TEXT PRIMARY KEY,parent_step TEXT)')
        db.execute('CREATE TABLE resolutions(id TEXT PRIMARY KEY,call TEXT NOT NULL UNIQUE,session TEXT NOT NULL,payload TEXT NOT NULL,FOREIGN KEY(call) REFERENCES scopes(id))')
        db.execute("INSERT INTO scopes VALUES('native')")
        original = ('decision','native','session','original evidence')
        db.execute('INSERT INTO resolutions VALUES(?,?,?,?)',original)
        ensure_resolution_schema(db)
        assert db.execute('SELECT id,call,session,payload FROM resolutions').fetchall() == [original]
        assert db.execute('SELECT native_call,plugin_call FROM resolutions').fetchone() == ('native',None)
        db.execute("INSERT INTO plugin_calls VALUES('plugin-call','model-step')")
        db.execute("INSERT INTO resolutions(id,call,session,payload,plugin_call) VALUES('plugin-decision','model-step','session','checked','plugin-call')")
        db.execute("INSERT INTO code_runs VALUES('script-run','script-step')")
        db.execute("INSERT INTO resolutions(id,call,session,payload,code_call) VALUES('code-decision','script-step','session','checked','script-run')")
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        ensure_resolution_schema(db)
        assert db.execute('SELECT count(*) FROM resolutions').fetchone()[0] == 3
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO resolutions(id,call,session,payload,plugin_call) VALUES('wrong-link','other-step','session','no','plugin-call')")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO resolutions(id,call,session,payload,native_call,plugin_call) VALUES('two-owners','other-step','session','no','native','plugin-call')")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO resolutions(id,call,session,payload,code_call) VALUES('wrong-code','other-step','session','no','script-run')")
