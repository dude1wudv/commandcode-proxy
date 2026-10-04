// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import GroupsPanel from './GroupsPanel.vue';
import type { Upstream, Client } from './api';

describe('group management', () => {
  it('shows membership, filters by group and protects default or populated groups from deletion', async () => {
    const groups = [
      { id: 'default', name: '默认分组', notes: '' },
      { id: 'pool-b', name: '独立分组', notes: '' },
      { id: 'empty', name: '空分组', notes: '' },
    ];
    const wrapper = mount(GroupsPanel, { props: {
      groups, busy: false,
      upstreams: [{ id: 'a', group_id: 'default' }] as Upstream[],
      clients: [{ id: 'k', group_id: 'pool-b' }] as Client[],
    } });
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0].text()).toContain('1 个账号');
    expect(rows[1].text()).toContain('1 个客户端');
    expect(rows[0].find('button.danger').attributes('disabled')).toBeDefined();
    expect(rows[1].find('button.danger').attributes('disabled')).toBeDefined();
    expect(rows[2].find('button.danger').attributes('disabled')).toBeUndefined();
    await rows[1].findAll('button')[1].trigger('click');
    expect(wrapper.emitted('browse')?.[0]).toEqual(['clients', groups[1]]);
    await rows[2].find('button.danger').trigger('click');
    expect(wrapper.emitted('remove')?.[0]).toEqual([groups[2]]);
    wrapper.unmount();
  });
});
