import retry from 'async-retry';
import { sql } from 'drizzle-orm';
import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/xata-http';
import type { XataHttpClient, XataHttpDatabase } from 'drizzle-orm/xata-http';
import { migrate } from 'drizzle-orm/xata-http/migrator';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { skipTests } from '~/common';
import { randomString } from '~/utils';
import { getXataClient } from '../xata/xata.ts';
import { tests, tests as cacheTests, usersMigratorTable, usersTable } from './pg-common';
import { TestCache, TestGlobalCache } from './pg-common-cache.ts';

const ENABLE_LOGGING = false;

let db: XataHttpDatabase;
let dbGlobalCached: XataHttpDatabase;
let cachedDb: XataHttpDatabase;
let client: XataHttpClient;

beforeAll(async () => {
	const apiKey = process.env['XATA_API_KEY'];
	if (!apiKey) {
		throw new Error('XATA_API_KEY is not defined');
	}

	client = await retry(async () => {
		client = getXataClient();
		return client;
	}, {
		retries: 20,
		factor: 1,
		minTimeout: 250,
		maxTimeout: 250,
		randomize: false,
	});
	db = drizzle(client, { logger: ENABLE_LOGGING });
	cachedDb = drizzle(client, { logger: ENABLE_LOGGING, cache: new TestCache() });
	dbGlobalCached = drizzle(client, { logger: ENABLE_LOGGING, cache: new TestGlobalCache() });
});

beforeEach((ctx) => {
	ctx.pg = {
		db,
	};
	ctx.cachedPg = {
		db: cachedDb,
		dbGlobalCached,
	};
});

test('migrator : default migration strategy', async () => {
	await db.execute(sql`drop table if exists all_columns`);
	await db.execute(sql`drop table if exists users12`);
	await db.execute(sql`drop table if exists "drizzle"."__drizzle_migrations"`);

	await migrate(db, { migrationsFolder: './drizzle2/pg' });

	await db.insert(usersMigratorTable).values({ name: 'John', email: 'email' });

	const result = await db.select().from(usersMigratorTable);

	expect(result).toEqual([{ id: 1, name: 'John', email: 'email' }]);

	await db.execute(sql`drop table all_columns`);
	await db.execute(sql`drop table users12`);
	await db.execute(sql`drop table "drizzle"."__drizzle_migrations"`);
});

test('migrator : migrate with custom table', async () => {
	const customTable = randomString();
	await db.execute(sql`drop table if exists all_columns`);
	await db.execute(sql`drop table if exists users12`);
	await db.execute(sql`drop table if exists "drizzle"."__drizzle_migrations"`);

	await migrate(db, { migrationsFolder: './drizzle2/pg', migrationsTable: customTable });

	// test if the custom migrations table was created
	const { records } = await db.execute(sql`select * from "drizzle".${sql.identifier(customTable)};`);
	expect(records && records.length > 0).toBeTruthy();

	// test if the migrated table are working as expected
	await db.insert(usersMigratorTable).values({ name: 'John', email: 'email' });
	const result = await db.select().from(usersMigratorTable);
	expect(result).toEqual([{ id: 1, name: 'John', email: 'email' }]);

	await db.execute(sql`drop table all_columns`);
	await db.execute(sql`drop table users12`);
	await db.execute(sql`drop table "drizzle".${sql.identifier(customTable)}`);
});

test('all date and time columns without timezone first case mode string', async () => {
	const table = pgTable('all_columns', {
		id: serial('id').primaryKey(),
		timestamp: timestamp('timestamp_string', { mode: 'string', precision: 6 }).notNull(),
	});

	await db.execute(sql`drop table if exists ${table}`);

	await db.execute(sql`
		create table ${table} (
					id serial primary key,
					timestamp_string timestamp(6) not null
			)
	`);

	// 1. Insert date in string format without timezone in it
	await db.insert(table).values([
		{ timestamp: '2022-01-01 02:00:00.123456' },
	]);

	// 2, Select in string format and check that values are the same
	const result = await db.select().from(table);

	expect(result).toEqual([{ id: 1, timestamp: '2022-01-01 02:00:00.123456' }]);

	// 3. Select as raw query and check that values are the same
	const result2 = await db.execute<{
		id: number;
		timestamp_string: string;
	}>(sql`select * from ${table}`);

	expect(result2.records).toEqual([{ id: 1, timestamp_string: '2022-01-01 02:00:00.123456' }]);

	await db.execute(sql`drop table if exists ${table}`);
});

test('all date and time columns without timezone second case mode string', async () => {
	const table = pgTable('all_columns', {
		id: serial('id').primaryKey(),
		timestamp: timestamp('timestamp_string', { mode: 'string', precision: 6 }).notNull(),
	});

	await db.execute(sql`drop table if exists ${table}`);

	await db.execute(sql`
		create table ${table} (
					id serial primary key,
					timestamp_string timestamp(6) not null
			)
	`);

	// 1. Insert date in string format with timezone in it
	await db.insert(table).values([
		{ timestamp: '2022-01-01T02:00:00.123456-02' },
	]);

	// 2, Select as raw query and check that values are the same
	const result = await db.execute<{
		id: number;
		timestamp_string: string;
	}>(sql`select * from ${table}`);

	expect(result.records).toEqual([{ id: 1, timestamp_string: '2022-01-01 02:00:00.123456' }]);

	await db.execute(sql`drop table if exists ${table}`);
});

test('all date and time columns without timezone third case mode date', async () => {
	const table = pgTable('all_columns', {
		id: serial('id').primaryKey(),
		timestamp: timestamp('timestamp_string', { mode: 'date', precision: 3 }).notNull(),
	});

	await db.execute(sql`drop table if exists ${table}`);

	await db.execute(sql`
		create table ${table} (
					id serial primary key,
					timestamp_string timestamp(3) not null
			)
	`);

	const insertedDate = new Date('2022-01-01 20:00:00.123+04');

	// 1. Insert date as new date
	await db.insert(table).values([
		{ timestamp: insertedDate },
	]);

	// 2, Select as raw query as string
	const result = await db.execute<{
		id: number;
		timestamp_string: string;
	}>(sql`select * from ${table}`);

	// 3. Compare both dates using orm mapping - Need to add 'Z' to tell JS that it is UTC
	expect(new Date(result.records[0]!.timestamp_string + 'Z').getTime()).toBe(insertedDate.getTime());

	await db.execute(sql`drop table if exists ${table}`);
});

test('test mode string for timestamp with timezone', async () => {
	const table = pgTable('all_columns', {
		id: serial('id').primaryKey(),
		timestamp: timestamp('timestamp_string', { mode: 'string', withTimezone: true, precision: 6 }).notNull(),
	});

	await db.execute(sql`drop table if exists ${table}`);

	await db.execute(sql`
		create table ${table} (
					id serial primary key,
					timestamp_string timestamp(6) with time zone not null
			)
	`);

	const timestampString = '2022-01-01 00:00:00.123456-0200';

	// 1. Insert date in string format with timezone in it
	await db.insert(table).values([
		{ timestamp: timestampString },
	]);

	// 2. Select date in string format and check that the values are the same
	const result = await db.select().from(table);

	// 2.1 Notice that postgres will return the date in UTC, but it is exactly the same
	expect(result).toEqual([{ id: 1, timestamp: '2022-01-01 02:00:00.123456+00' }]);

	// 3. Select as raw query and checke that values are the same
	const result2 = await db.execute<{
		id: number;
		timestamp_string: string;
	}>(sql`select * from ${table}`);

	// 3.1 Notice that postgres will return the date in UTC, but it is exactlt the same
	expect(result2.records).toEqual([{ id: 1, timestamp_string: '2022-01-01 02:00:00.123456+00' }]);

	await db.execute(sql`drop table if exists ${table}`);
});

test('test mode date for timestamp with timezone', async () => {
	const table = pgTable('all_columns', {
		id: serial('id').primaryKey(),
		timestamp: timestamp('timestamp_string', { mode: 'date', withTimezone: true, precision: 3 }).notNull(),
	});

	await db.execute(sql`drop table if exists ${table}`);

	await db.execute(sql`
		create table ${table} (
					id serial primary key,
					timestamp_string timestamp(3) with time zone not null
			)
	`);

	const timestampString = new Date('2022-01-01 00:00:00.456-0200');

	// 1. Insert date in string format with timezone in it
	await db.insert(table).values([
		{ timestamp: timestampString },
	]);

	// 2. Select date in string format and check that the values are the same
	const result = await db.select().from(table);

	// 2.1 Notice that postgres will return the date in UTC, but it is exactly the same
	expect(result).toEqual([{ id: 1, timestamp: timestampString }]);

	// 3. Select as raw query and checke that values are the same
	const result2 = await db.execute<{
		id: number;
		timestamp_string: string;
	}>(sql`select * from ${table}`);

	// 3.1 Notice that postgres will return the date in UTC, but it is exactlt the same
	expect(result2.records).toEqual([{ id: 1, timestamp_string: '2022-01-01 02:00:00.456+00' }]);

	await db.execute(sql`drop table if exists ${table}`);
});

test('test mode string for timestamp with timezone in UTC timezone', async () => {
	// get current timezone from db
	const timezone = await db.execute<{ TimeZone: string }>(sql`show timezone`);

	// set timezone to UTC
	await db.execute(sql`set time zone 'UTC'`);

	const table = pgTable('all_columns', {
		id: serial('id').primaryKey(),
		timestamp: timestamp('timestamp_string', { mode: 'string', withTimezone: true, precision: 6 }).notNull(),
	});

	await db.execute(sql`drop table if exists ${table}`);

	await db.execute(sql`
		create table ${table} (
					id serial primary key,
					timestamp_string timestamp(6) with time zone not null
			)
	`);

	const timestampString = '2022-01-01 00:00:00.123456-0200';

	// 1. Insert date in string format with timezone in it
	await db.insert(table).values([
		{ timestamp: timestampString },
	]);

	// 2. Select date in string format and check that the values are the same
	const result = await db.select().from(table);

	// 2.1 Notice that postgres will return the date in UTC, but it is exactly the same
	expect(result).toEqual([{ id: 1, timestamp: '2022-01-01 02:00:00.123456+00' }]);

	// 3. Select as raw query and checke that values are the same
	const result2 = await db.execute<{
		id: number;
		timestamp_string: string;
	}>(sql`select * from ${table}`);

	// 3.1 Notice that postgres will return the date in UTC, but it is exactlt the same
	expect(result2.records).toEqual([{ id: 1, timestamp_string: '2022-01-01 02:00:00.123456+00' }]);

	await db.execute(sql`set time zone '${sql.raw(timezone.records[0]!.TimeZone)}'`);

	await db.execute(sql`drop table if exists ${table}`);
});

test('test mode string for timestamp with timezone in different timezone', async () => {
	// get current timezone from db
	const timezone = await db.execute<{ TimeZone: string }>(sql`show timezone`);

	// set timezone to HST (UTC - 10)
	await db.execute(sql`set time zone 'HST'`);

	const table = pgTable('all_columns', {
		id: serial('id').primaryKey(),
		timestamp: timestamp('timestamp_string', { mode: 'string', withTimezone: true, precision: 6 }).notNull(),
	});

	await db.execute(sql`drop table if exists ${table}`);

	await db.execute(sql`
		create table ${table} (
					id serial primary key,
					timestamp_string timestamp(6) with time zone not null
			)
	`);

	const timestampString = '2022-01-01 00:00:00.123456-1000';

	// 1. Insert date in string format with timezone in it
	await db.insert(table).values([
		{ timestamp: timestampString },
	]);

	// 2. Select date in string format and check that the values are the same
	const result = await db.select().from(table);

	expect(result).toEqual([{ id: 1, timestamp: '2022-01-01 00:00:00.123456-10' }]);

	// 3. Select as raw query and checke that values are the same
	const result2 = await db.execute<{
		id: number;
		timestamp_string: string;
	}>(sql`select * from ${table}`);

	expect(result2.records).toEqual([{ id: 1, timestamp_string: '2022-01-01 00:00:00.123456-10' }]);

	await db.execute(sql`set time zone '${sql.raw(timezone.records[0]!.TimeZone)}'`);

	await db.execute(sql`drop table if exists ${table}`);
});

skipTests([
	'migrator : default migration strategy',
	'migrator : migrate with custom schema',
	'migrator : migrate with custom table',
	'migrator : migrate with custom table and custom schema',
	'insert via db.execute + select via db.execute',
	'insert via db.execute + returning',
	'insert via db.execute w/ query builder',
	'all date and time columns without timezone first case mode string',
	'all date and time columns without timezone third case mode date',
	'test mode string for timestamp with timezone',
	'test mode date for timestamp with timezone',
	'test mode string for timestamp with timezone in UTC timezone',
	'test mode string for timestamp with timezone in different timezone',
	'view',
	'materialized view',
	'select from enum',
	'subquery with view',
]);
tests();
cacheTests();

beforeEach(async () => {
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`create schema public`);
	await db.execute(
		sql`
			create table users (
				id serial primary key,
				name text not null,
				verified boolean not null default false, 
				jsonb jsonb,
				created_at timestamptz not null default now()
			)
		`,
	);
});

test('insert via db.execute + select via db.execute', async () => {
	await db.execute(
		sql`insert into ${usersTable} (${sql.identifier(usersTable.name.name)}) values (${'John'})`,
	);

	const result = await db.execute<{ id: number; name: string }>(
		sql`select id, name from "users"`,
	);
	expect(result.records).toEqual([{ id: 1, name: 'John' }]);
});

test('insert via db.execute + returning', async () => {
	const inserted = await db.execute<{ id: number; name: string }>(
		sql`insert into ${usersTable} (${
			sql.identifier(
				usersTable.name.name,
			)
		}) values (${'John'}) returning ${usersTable.id}, ${usersTable.name}`,
	);
	expect(inserted.records).toEqual([{ id: 1, name: 'John' }]);
});

test('insert via db.execute w/ query builder', async () => {
	const inserted = await db.execute<Pick<typeof usersTable.$inferSelect, 'id' | 'name'>>(
		db
			.insert(usersTable)
			.values({ name: 'John' })
			.returning({ id: usersTable.id, name: usersTable.name }),
	);
	expect(inserted.records).toEqual([{ id: 1, name: 'John' }]);
});
