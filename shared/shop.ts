import type { ShopItem } from './types';

// Made-up partner shops for the demo. Vouchers copy title/partner at purchase time, so editing this list never
// breaks existing vouchers.
export const SHOP_ITEMS: ShopItem[] = [
  { id: 'bahdja-espresso', partner: 'Café El Bahdja', title: 'Espresso on the house', emoji: '☕', tone: 'sun',
    description: 'One espresso or nousnous at the counter. Sit by the window and enjoy the view.', cost: 100 },
  { id: 'bahdja-makroud', partner: 'Café El Bahdja', title: 'Makroud & mint tea', emoji: '🍵', tone: 'sun',
    description: 'A plate of honey makroud with a pot of fresh mint tea for two.', cost: 180 },
  { id: 'zitoun-slice', partner: 'Pizzeria Dar Zitoun', title: 'Slice + soda', emoji: '🍕', tone: 'coral',
    description: 'Any slice from the wood oven, plus a cold drink.', cost: 150 },
  { id: 'nakhla-plant', partner: 'Pépinière Nakhla', title: 'Potted plant', emoji: '🪴', tone: 'mint',
    description: 'A small potted plant to take home. Keep the city green, start with your balcony.', cost: 250 },
  { id: 'kalima-bookmark', partner: 'Librairie Kalima', title: 'Illustrated bookmark set', emoji: '🔖', tone: 'grape',
    description: 'A set of three bookmarks drawn by local artists.', cost: 80 },
  { id: 'kalima-book', partner: 'Librairie Kalima', title: 'Pocket book of your choice', emoji: '📚', tone: 'grape',
    description: 'Pick any pocket edition from the shelves: novels, poetry or comics.', cost: 400 },
  { id: 'sahel-paddle', partner: 'Sahel Surf Club', title: '1-hour paddleboard', emoji: '🏄', tone: 'sky',
    description: 'One hour of paddleboard rental, board and vest included. Summer weekends only.', cost: 500 },
  { id: 'sahara-ticket', partner: 'Cinéma Sahara', title: 'Movie ticket', emoji: '🎬', tone: 'night',
    description: 'One ticket for any screening, any day of the week.', cost: 350 },
];
