-- ============================================================
-- 039_hotel_menu_orders.sql — Hotel menu & ordering schema
--
-- Adds three tables for the AI hotel ordering assistant:
--   - menu_items: the restaurant / room-service menu
--   - orders: a guest's food order (linked to a conversation)
--   - order_items: individual line items in an order
--
-- RLS: settings-class for menu_items (admin+ may CRUD, anyone in
-- account may read). Orders and order_items follow the same pattern
-- as conversations — agent+ may insert, anyone may read within the
-- account.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- MENU ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  price         numeric(10,2) NOT NULL CHECK (price >= 0),
  category      text NOT NULL DEFAULT 'General',
  is_available  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_account_id ON menu_items(account_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(account_id, category);

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS menu_items_select ON menu_items;
CREATE POLICY menu_items_select ON menu_items FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS menu_items_insert ON menu_items;
CREATE POLICY menu_items_insert ON menu_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS menu_items_update ON menu_items;
CREATE POLICY menu_items_update ON menu_items FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS menu_items_delete ON menu_items;
CREATE POLICY menu_items_delete ON menu_items FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_menu_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS menu_items_updated_at ON menu_items;
CREATE TRIGGER menu_items_updated_at
  BEFORE UPDATE ON menu_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_menu_items_updated_at();

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TYPE order_status_enum AS ENUM (
  'pending', 'confirmed', 'preparing', 'delivered', 'cancelled'
);

CREATE TABLE IF NOT EXISTS orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id            uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id       uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status                order_status_enum NOT NULL DEFAULT 'pending',
  room_or_table         text,
  special_instructions  text,
  total_price           numeric(10,2) NOT NULL DEFAULT 0 CHECK (total_price >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_account_id ON orders(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_contact_id ON orders(contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_conversation_id ON orders(conversation_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(account_id, status);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_delete ON orders;
CREATE POLICY orders_delete ON orders FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_orders_updated_at();

-- ============================================================
-- ORDER ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  menu_item_id          uuid NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  quantity              integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_at_order_time   numeric(10,2) NOT NULL CHECK (price_at_order_time >= 0),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_account_id ON order_items(account_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_items_select ON order_items;
CREATE POLICY order_items_select ON order_items FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS order_items_insert ON order_items;
CREATE POLICY order_items_insert ON order_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS order_items_update ON order_items;
CREATE POLICY order_items_update ON order_items FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS order_items_delete ON order_items;
CREATE POLICY order_items_delete ON order_items FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- RPC: Create order with items in a single transaction.
--
-- The hotel agent calls this to atomically create an order + its
-- line items and compute the total. Returns the new order id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_hotel_order(
  p_account_id       uuid,
  p_contact_id       uuid,
  p_conversation_id  uuid,
  p_room_or_table    text,
  p_special_instructions text,
  p_items            jsonb   -- [{ menu_item_id: uuid, quantity: int }, ...]
)
RETURNS uuid AS $$
DECLARE
  v_order_id uuid;
  v_total    numeric(10,2) := 0;
  v_item     jsonb;
  v_menu_row menu_items%ROWTYPE;
BEGIN
  -- Create the order shell
  INSERT INTO orders (account_id, contact_id, conversation_id, room_or_table, special_instructions, status)
  VALUES (p_account_id, p_contact_id, p_conversation_id, p_room_or_table, p_special_instructions, 'pending')
  RETURNING id INTO v_order_id;

  -- Iterate items and insert line items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Lock the menu item row to prevent concurrent availability races
    SELECT * INTO v_menu_row
    FROM menu_items
    WHERE id = (v_item->>'menu_item_id')::uuid
      AND account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Menu item % not found or not available in this account', v_item->>'menu_item_id';
    END IF;

    IF NOT v_menu_row.is_available THEN
      RAISE EXCEPTION 'Menu item "%" is currently unavailable', v_menu_row.name;
    END IF;

    INSERT INTO order_items (order_id, account_id, menu_item_id, quantity, price_at_order_time)
    VALUES (
      v_order_id,
      p_account_id,
      v_menu_row.id,
      (v_item->>'quantity')::int,
      v_menu_row.price
    );

    v_total := v_total + (v_menu_row.price * (v_item->>'quantity')::int);
  END LOOP;

  -- Update total
  UPDATE orders SET total_price = v_total WHERE id = v_order_id;

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Lock down EXECUTE — service role only (the hotel agent runs under
-- service-role, not authenticated).
REVOKE ALL ON FUNCTION public.create_hotel_order(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_hotel_order(uuid, uuid, uuid, text, text, jsonb) TO service_role;
