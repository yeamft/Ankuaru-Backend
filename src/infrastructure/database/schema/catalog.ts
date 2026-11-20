import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";

export const catalogCategories = pgTable("catalog_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  nameAm: text("name_am"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [check("catalog_categories_id_check", sql`${table.id} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`)]);

export const catalogProducts = pgTable("catalog_products", {
  id: text("id").primaryKey(),
  categoryId: text("category_id").notNull().references(() => catalogCategories.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  nameAm: text("name_am"),
  /** How the product is traded: Quintal, MT, kg, Bag or Piece. */
  unit: text("unit").notNull().default("Quintal"),
  description: text("description").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("catalog_products_category_key_unique").on(table.categoryId, table.key),
  unique("catalog_products_id_category_unique").on(table.id, table.categoryId),
  check("catalog_products_id_check", sql`${table.id} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  check("catalog_products_key_check", sql`${table.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
]);

export const catalogProperties = pgTable("catalog_properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: text("category_id").notNull().references(() => catalogCategories.id),
  productId: text("product_id"),
  key: text("key").notNull(),
  name: text("name").notNull(),
  nameAm: text("name_am"),
  required: boolean("required").notNull().default(false),
  /** Answered from a list of values ("select"), as a number, or as free text. */
  inputType: text("input_type").notNull().default("select"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("catalog_properties_category_key_unique").on(table.categoryId, table.key),
  foreignKey({ columns: [table.productId, table.categoryId], foreignColumns: [catalogProducts.id, catalogProducts.categoryId] }),
  check("catalog_properties_key_check", sql`${table.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
]);

export const catalogPropertyValues = pgTable("catalog_property_values", {
  id: uuid("id").primaryKey().defaultRandom(),
  propertyId: uuid("property_id").notNull().references(() => catalogProperties.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  nameAm: text("name_am"),
  aliases: text("aliases").array().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("catalog_property_values_property_key_unique").on(table.propertyId, table.key),
  unique("catalog_property_values_id_property_unique").on(table.id, table.propertyId),
  check("catalog_property_values_key_check", sql`${table.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
]);
