"use strict";

const fs      = require('fs');

const {
    LUAL_BUFFERSIZE,
    lua_getlocaledecpoint
} = require('./luaconf.js');
const {
    LUA_MINSTACK,
    LUA_REGISTRYINDEX,
    LUA_TNUMBER,
    lua_getfield,
    lua_gettop,
    lua_isnil,
    lua_isnone,
    lua_isnoneornil,
    lua_newuserdata,
    lua_pop,
    lua_pushboolean,
    lua_pushcclosure,
    lua_pushinteger,
    lua_pushliteral,
    lua_pushnil,
    lua_pushstring,
    lua_pushvalue,
    lua_rawlen,
    lua_replace,
    lua_rotate,
    lua_setfield,
    lua_settop,
    lua_stringtonumber,
    lua_toboolean,
    lua_tointeger,
    lua_tostring,
    lua_touserdata,
    lua_type,
    lua_upvalueindex
} = require('./lua.js');
const {
    LUA_FILEHANDLE,
    luaL_Buffer,
    luaL_addsize,
    luaL_addchar,
    luaL_argcheck,
    luaL_argerror,
    luaL_buffinit,
    luaL_checkany,
    luaL_checkinteger,
    luaL_checklstring,
    luaL_checkstring,
    luaL_checkstack,
    luaL_checkudata,
    luaL_error,
    luaL_fileresult,
    luaL_newlib,
    luaL_newmetatable,
    luaL_pushresult,
    luaL_prepbuffer,
    luaL_prepbuffsize,
    luaL_setfuncs,
    luaL_setmetatable,
    luaL_testudata
} = require('./lauxlib.js');
const lualib = require('./lualib.js');
const { to_luastring } = require("./fengaricore.js");

const EOF = -1;
const getc = function(rs) {
    if (rs.readableLength === 0) {
        let buff = new Uint8Array(1);
        let got;
        try {
            got = fs.readSync(rs.fd, buff, 0, 1, null);
        } catch (e) {
            rs.destroy(e);
            return EOF;
        }
        if (got == 0) {
            rs.push('');
            return EOF;
        }
        rs.push(buff);
    }
    let c = rs._readableState.buffer.get(0);
    rs._readableState.buffer.consume(1);
    return c;
};

const ungetc = function(c, rs) {
    rs._readableState.buffer.unshift(Uint8Array.of(c));
};

const fread = function(buff, n, rs) {
    if (rs.readableLength === 0) {
        let buff = new Uint8Array(n);
        let got;
        try {
            got = fs.readSync(rs.fd, buff, 0, n, null);
        } catch (e) {
            rs.destroy(e);
            return EOF;
        }
        rs.push(buff.subarray(0, got));
        if (got == 0)
            return 0;
    }
    let sz = Math.min(rs.readableLength, n);
    rs._readableState.buffer.copy(buff, 0, 0, sz);
    rs._readableState.buffer.consume(sz);
    return sz;
};

const clearerr = function(rs) {
};

const ferror = function(rs) {
    return void 0;
};

const l_getc = getc;
const l_lockfile = function(){};
const l_unlockfile = function(){};

const IO_PREFIX = "_IO_";
const IOPREF_LEN = IO_PREFIX.length;
const IO_INPUT = to_luastring(IO_PREFIX + "input");
const IO_OUTPUT = to_luastring(IO_PREFIX + "output");

const tolstream = function(L) {
    return luaL_checkudata(L, 1, LUA_FILEHANDLE);
};

const isclosed = function(p) {
    return p.closef === null;
};

const io_type = function(L) {
    luaL_checkany(L, 1);
    let p = luaL_testudata(L, 1, LUA_FILEHANDLE);
    if (p === null)
        lua_pushnil(L);  /* not a file */
    else if (isclosed(p))
        lua_pushliteral(L, "closed file");
    else
        lua_pushliteral(L, "file");
    return 1;
};

const f_tostring = function(L) {
    let p = tolstream(L);
    if (isclosed(p))
        lua_pushliteral(L, "file (closed)");
    else
        lua_pushstring(L, to_luastring(`file (${p.f.toString()})`));
    return 1;
};

const tofile = function(L) {
    let p = tolstream(L);
    if (isclosed(p))
        luaL_error(L, to_luastring("attempt to use a closed file"));
    lualib.lua_assert(p.f);
    return p.f;
};

const newprefile = function(L) {
    let p = lua_newuserdata(L);
    p.f = null;
    p.closef = null;
    luaL_setmetatable(L, LUA_FILEHANDLE);
    return p;
};

const aux_close = function(L) {
    let p = tolstream(L);
    let cf = p.closef;
    p.closef = null;
    return cf(L);
};

const io_close = function(L) {
    if (lua_isnone(L, 1))  /* no argument? */
        lua_getfield(L, LUA_REGISTRYINDEX, IO_OUTPUT);  /* use standard output */
    tofile(L);  /* make sure argument is an open stream */
    return aux_close(L);
};

const getiofile = function(L, findex) {
    lua_getfield(L, LUA_REGISTRYINDEX, findex);
    let p = lua_touserdata(L, -1);
    if (isclosed(p))
        luaL_error(L, to_luastring("standard %s file is closed"), findex.subarray(IOPREF_LEN));
    return p.f;
};

const g_iofile = function(L, f, mode) {
    if (!lua_isnoneornil(L, 1)) {
        let filename = lua_tostring(L, 1);
        if (filename)
            luaL_error(L, to_luastring("opening files not yet implemented"));
        else {
            tofile(L);  /* check that it's a valid file handle */
            lua_pushvalue(L, 1);
        }
        lua_setfield(L, LUA_REGISTRYINDEX, f);
    }
    /* return current value */
    lua_getfield(L, LUA_REGISTRYINDEX, f);
    return 1;
};

const io_input = function(L) {
    return g_iofile(L, IO_INPUT, "r");
};

const io_output = function(L) {
    return g_iofile(L, IO_OUTPUT, "w");
};

let io_readline;

/*
** maximum number of arguments to 'f:lines'/'io.lines' (it + 3 must fit
** in the limit for upvalues of a closure)
*/
const MAXARGLINE = 250;

const aux_lines = function(L, toclose) {
    let n = lua_gettop(L) - 1;  /* number of arguments to read */
    luaL_argcheck(L, n <= MAXARGLINE, MAXARGLINE + 2, to_luastring("too many arguments"));
    lua_pushinteger(L, n);  /* number of arguments to read */
    lua_pushboolean(L, toclose);  /* close/not close file when finished */
    lua_rotate(L, 2, 2);  /* move 'n' and 'toclose' to their positions */
    lua_pushcclosure(L, io_readline, 3 + n);
};

const io_lines = function(L) {
    let toclose;
    if (lua_isnone(L, 1)) lua_pushnil(L);  /* at least one argument */
    if (lua_isnil(L, 1)) {  /* no file name? */
        lua_getfield(L, LUA_REGISTRYINDEX, IO_INPUT);  /* get default input */
        lua_replace(L, 1);  /* put it at index 1 */
        tofile(L);  /* check that it's a valid file handle */
        toclose = 0;  /* do not close it after iteration */
    }
    else {  /* open a new file */
        luaL_error(L, to_luastring("opening files not yet implemented"));
    }
    aux_lines(L, toclose);
    return 1;
};

/* maximum length of a numeral */
const L_MAXLENNUM = 200;

/*
** Add current char to buffer (if not out of space) and read next one
*/
const nextc = function(rn) {
    if (rn.n >= L_MAXLENNUM) {  /* buffer overflow? */
        rn.buff[0] = '\0';  /* invalidate result */
        return 0;  /* fail */
    }
    else {
        rn.buff[rn.n++] = rn.c;  /* save current char */
        rn.c = l_getc(rn.f);  /* read next one */
        return 1;
    }
};


/*
** Accept current char if it is in 'set' (of size 2)
*/
const test2 = function(rn, set_0, set_1) {
    if (rn.c == set_0 || rn.c == set_1)
        return nextc(rn);
    else return 0;
};


/*
** Read a sequence of (hex)digits
*/
const readdigits = function(rn, hex) {
    let count = 0;
    while ((hex ? isxdigit(rn.c) : isdigit(rn.c)) && nextc(rn))
        count++;
    return count;
};


/*
** Read a number: first reads a valid prefix of a numeral into a buffer.
** Then it calls 'lua_stringtonumber' to check whether the format is
** correct and to convert it to a Lua number
*/
const read_number = function(L, f) {
    let count = 0;
    let hex = 0;
    let rn = {
        f: f,  /* file being read */
        c: 0,  /* current character (look ahead) */
        n: 0,  /* number of elements in buffer 'buff' */
        buff: new Uint8Array(L_MAXLENNUM + 1)  /* +1 for ending '\0' */
    };
    let decp_0 = lua_getlocaledecpoint();  /* get decimal point from locale */
    let decp_1 = 46 /* '.' */;  /* always accept a dot */
    l_lockfile(rn.f);
    do { rn.c = l_getc(rn.f); } while (isspace(rn.c));  /* skip spaces */
    test2(rn, 45, 43/* "-+" */);  /* optional signal */
    if (test2(rn, 48, 48 /* "00" */)) {
        if (test2(rn, 120, 88 /* "xX" */)) hex = 1;  /* numeral is hexadecimal */
        else count = 1;  /* count initial '0' as a valid digit */
    }
    count += readdigits(rn, hex);  /* integral part */
    if (test2(rn, decp_0, decp_1))  /* decimal point? */
        count += readdigits(rn, hex);  /* fractional part */
    if (count > 0 && test2(rn, hex ? 112 : 101, hex ? 80 : 69 /* (hex ? "pP" : "eE") */)) {  /* exponent mark? */
        test2(rn, 45, 43/* "-+" */);  /* exponent signal */
        readdigits(rn, 0);  /* exponent digits */
    }
    ungetc(rn.c, rn.f);  /* unread look-ahead char */
    l_unlockfile(rn.f);
    rn.buff[rn.n] = '\0';  /* finish string */
    if (lua_stringtonumber(L, rn.buff))  /* is this a valid number? */
        return 1;  /* ok */
    else {  /* invalid format */
        lua_pushnil(L);  /* "result" to be removed */
        return 0;  /* read fails */
    }
};


const test_eof = function(L, f) {
    let c = getc(f);
    ungetc(c, f);  /* no-op when c == EOF */
    lua_pushliteral(L, "");
    return (c != EOF);
};


const read_line = function(L, f, chop) {
    let b = new luaL_Buffer();
    let c = 0;
    luaL_buffinit(L, b);
    while (c != EOF && c != 13 /* '\n' */) {  /* repeat until end of line */
        let buff = luaL_prepbuffer(b);  /* preallocate buffer */
        let i = 0;
        l_lockfile(f);  /* no memory errors can happen inside the lock */
        while (i < LUAL_BUFFERSIZE && (c = l_getc(f)) != EOF && c != 13 /* '\n' */)
            buff[i++] = c;
        l_unlockfile(f);
        luaL_addsize(b, i);
    }
    if (!chop && c == 13 /* '\n' */)  /* want a newline and have one? */
        luaL_addchar(b, c);  /* add ending newline to result */
    luaL_pushresult(b);  /* close buffer */
    /* return ok if read something (either a newline or something else) */
    return (c == 13 /* '\n' */ || lua_rawlen(L, -1) > 0);
};


const read_all = function(L, f) {
    let nr;
    let b = new luaL_Buffer();
    luaL_buffinit(L, b);
    do {  /* read file in chunks of LUAL_BUFFERSIZE bytes */
        let p = luaL_prepbuffer(b);
        nr = fread(p, LUAL_BUFFERSIZE, f);
        luaL_addsize(b, nr);
    } while (nr == LUAL_BUFFERSIZE);
    luaL_pushresult(b);  /* close buffer */
};


const read_chars = function(L, f, n) {
    let nr;  /* number of chars actually read */
    let b = new luaL_Buffer();
    luaL_buffinit(L, b);
    let p = luaL_prepbuffsize(b, n);  /* prepare buffer to read whole block */
    nr = fread(p, n, f);  /* try to read 'n' chars */
    luaL_addsize(b, nr);
    luaL_pushresult(b);  /* close buffer */
    return (nr > 0);  /* true iff read something */
};


const g_read = function(L, f, first) {
    let nargs = lua_gettop(L) - 1;
    let success;
    let n;
    clearerr(f);
    if (nargs == 0) {  /* no arguments? */
        success = read_line(L, f, 1);
        console.log("G_READ", success);
        n = first+1;  /* to return 1 result */
    }
    else {  /* ensure stack space for all results and for auxlib's buffer */
        luaL_checkstack(L, nargs+LUA_MINSTACK, to_luastring("too many arguments"));
        success = 1;
        for (n = first; nargs-- && success; n++) {
            if (lua_type(L, n) == LUA_TNUMBER) {
                let l = luaL_checkinteger(L, n);
                success = (l == 0) ? test_eof(L, f) : read_chars(L, f, l);
            }
            else {
                let p = luaL_checkstring(L, n);
                if (p[0] == 42 /* '*' */) p = p.subarray(1);  /* skip optional '*' (for compatibility) */
                switch (p[0]) {
                    case 110 /* 'n' */:  /* number */
                        success = read_number(L, f);
                        break;
                    case 108 /* 'l' */:  /* line */
                        success = read_line(L, f, 1);
                        break;
                    case 76 /* 'L' */:  /* line with end-of-line */
                        success = read_line(L, f, 0);
                        break;
                    case 97 /* 'a' */:  /* file */
                        read_all(L, f);  /* read entire file */
                        success = 1;
                        break;
                    default:
                        return luaL_argerror(L, n, to_luastring("invalid format"));
                }
            }
        }
    }
    let e = ferror(f);
    if (e)
        return luaL_fileresult(L, 0, null, e);
    if (!success) {
        lua_pop(L, 1);  /* remove last result */
        lua_pushnil(L);  /* push nil instead */
    }
    return n - first;
};

io_readline = function(L) {
    let p = lua_touserdata(L, lua_upvalueindex(1));
    let i;
    let n = lua_tointeger(L, lua_upvalueindex(2));
    if (isclosed(p))  /* file is already closed? */
        return luaL_error(L, to_luastring("file is already closed"));
    lua_settop(L , 1);
    luaL_checkstack(L, n, to_luastring("too many arguments"));
    for (i = 1; i <= n; i++)  /* push arguments to 'g_read' */
        lua_pushvalue(L, lua_upvalueindex(3 + i));
    n = g_read(L, p.f, 2);  /* 'n' is number of results */
    lualib.lua_assert(n > 0);  /* should return at least a nil */
    if (lua_toboolean(L, -n))  /* read at least one value? */
        return n;  /* return them */
    else {  /* first result is nil: EOF or error */
        if (n > 1) {  /* is there error information? */
            /* 2nd result is error message */
            return luaL_error(L, to_luastring("%s"), lua_tostring(L, -n + 1));
        }
        if (lua_toboolean(L, lua_upvalueindex(3))) {  /* generator created file? */
            lua_settop(L, 0);
            lua_pushvalue(L, lua_upvalueindex(1));
            aux_close(L);  /* close it */
        }
        return 0;
    }
};

const g_write = function(L, f, arg) {
    let nargs = lua_gettop(L) - arg;
    let status = true;
    let err;
    for (; nargs--; arg++) {
        let s = luaL_checklstring(L, arg);
        try {
            status = status && (fs.writeSync(f.fd, Uint8Array.from(s)) === s.length);
        } catch (e) {
            status = false;
            err = e;
        }
    }
    if (status) return 1;  /* file handle already on stack top */
    else return luaL_fileresult(L, status, null, err);
};

const io_write = function(L) {
    return g_write(L, getiofile(L, IO_OUTPUT), 1);
};

const f_write = function(L) {
    let f = tofile(L);
    lua_pushvalue(L, 1); /* push file at the stack top (to be returned) */
    return g_write(L, f, 2);
};

const io_flush = function (L) {
    /* stub, as node doesn't have synchronized buffered IO */
    getiofile(L, IO_OUTPUT);
    return luaL_fileresult(L, true, null, null);
};

const f_flush = function (L) {
    /* stub, as node doesn't have synchronized buffered IO */
    tofile(L);
    return luaL_fileresult(L, true, null, null);
};

const iolib = {
    "close": io_close,
    "flush": io_flush,
    "input": io_input,
    "lines": io_lines,
    "output": io_output,
    "type": io_type,
    "write": io_write
};

const flib = {
    "close": io_close,
    "flush": f_flush,
    "write": f_write,
    "__tostring": f_tostring
};

const createmeta = function(L) {
    luaL_newmetatable(L, LUA_FILEHANDLE);  /* create metatable for file handles */
    lua_pushvalue(L, -1);  /* push metatable */
    lua_setfield(L, -2, to_luastring("__index", true));  /* metatable.__index = metatable */
    luaL_setfuncs(L, flib, 0);  /* add file methods to new metatable */
    lua_pop(L, 1);  /* pop new metatable */
};

const io_noclose = function(L) {
    let p = tolstream(L);
    p.closef = io_noclose;
    lua_pushnil(L);
    lua_pushliteral(L, "cannot close standard file");
    return 2;
};

const createstdfile = function(L, f, k, fname) {
    let p = newprefile(L);
    p.f = f;
    p.closef = io_noclose;
    if (k !== null) {
        lua_pushvalue(L, -1);
        lua_setfield(L, LUA_REGISTRYINDEX, k);  /* add file to registry */
    }
    lua_setfield(L, -2, fname);  /* add file to module */
};

const luaopen_io = function(L) {
    luaL_newlib(L, iolib);
    createmeta(L);
    /* create (and set) default files */
    createstdfile(L, process.stdin, IO_INPUT, to_luastring("stdin"));
    createstdfile(L, process.stdout, IO_OUTPUT, to_luastring("stdout"));
    createstdfile(L, process.stderr, null, to_luastring("stderr"));
    return 1;
};

module.exports.luaopen_io = luaopen_io;
