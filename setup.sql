-- ФИНАЛЬНЫЙ SQL-СКРИПТ (КОПИРОВАТЬ ЦЕЛИКОМ И НАЖАТЬ RUN)

-- 1. Таблица профилей (создаем если нет, или дополняем)
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  email text,
  name text,
  surname text,
  organization text,
  position text,
  phone text,
  region text,
  inn text,
  verified boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- 2. Таблица уведомлений (ОБЯЗАТЕЛЬНО НУЖНА ДЛЯ РАБОТЫ)
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  text text not null,
  read boolean default false,
  time timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

-- 3. Таблица заказов
create table if not exists public.orders (
  id text primary key default 'ord-' || substr(md5(random()::text), 1, 7),
  user_id uuid references auth.users(id) on delete cascade,
  user_email text,
  product_id text,
  product_name text,
  volume text,
  services jsonb default '[]',
  comment text default '',
  attachment_url text default '',
  status text default 'new',
  tracking_data jsonb default '{}',
  created_at timestamp with time zone default now()
);

-- 4. Таблица заявок на сервис
create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  user_email text,
  service_id text,
  service_name text,
  volume text,
  timeline text default 'normal',
  options jsonb default '[]',
  comment text default '',
  status text default 'new',
  created_at timestamp with time zone default now()
);

-- 5. Включение безопасности (RLS)
alter table public.profiles enable row level security;
alter table public.notifications enable row level security;
alter table public.orders enable row level security;
alter table public.service_requests enable row level security;

-- Пытаемся создать политики, игнорируя если они уже есть
do $$
begin
    -- Профили
    if not exists (select 1 from pg_policies where policyname = 'Users can view own profile') then
        create policy "Users can view own profile" on public.profiles for select using (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'Users can update own profile') then
        create policy "Users can update own profile" on public.profiles for update using (auth.uid() = user_id);
    end if;
    
    -- Уведомления
    if not exists (select 1 from pg_policies where policyname = 'Users can view own notifications') then
        create policy "Users can view own notifications" on public.notifications for select using (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'Users can update own notifications') then
        create policy "Users can update own notifications" on public.notifications for update using (auth.uid() = user_id);
    end if;

    -- Заказы
    if not exists (select 1 from pg_policies where policyname = 'Users can view own orders') then
        create policy "Users can view own orders" on public.orders for select using (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'Users can insert own orders') then
        create policy "Users can insert own orders" on public.orders for insert with check (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'Users can update own orders') then
        create policy "Users can update own orders" on public.orders for update using (auth.uid() = user_id);
    end if;

    -- Заявки на сервис
    if not exists (select 1 from pg_policies where policyname = 'Users can view own service_requests') then
        create policy "Users can view own service_requests" on public.service_requests for select using (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'Users can insert own service_requests') then
        create policy "Users can insert own service_requests" on public.service_requests for insert with check (auth.uid() = user_id);
    end if;
end $$;

-- 6. Функция авто-профиля (если еще нет)
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (user_id, email, name, surname)
  values (new.id, new.email, new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'surname')
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$ language plpgsql security definer;

-- 7. Индексы
create index if not exists idx_profiles_user_id on public.profiles(user_id);
create index if not exists idx_notifications_user_id on public.notifications(user_id);
create index if not exists idx_orders_user_id on public.orders(user_id);
create index if not exists idx_service_requests_user_id on public.service_requests(user_id);
