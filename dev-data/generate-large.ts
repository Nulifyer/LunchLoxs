/**
 * Generate a large test dataset with configurable size.
 *
 * Usage:
 *   bun run dev-data/generate-large.ts                    # default: 15 books, 30 recipes each
 *   bun run dev-data/generate-large.ts 5 10               # 5 books, 10 recipes each
 *   bun run dev-data/generate-large.ts 20 50              # 20 books, 50 recipes each
 */
import JSZip from "jszip";
import { writeFileSync } from "fs";
import { join } from "path";

const NUM_BOOKS = parseInt(process.argv[2] ?? "15");
const RECIPES_PER_BOOK = parseInt(process.argv[3] ?? "30");

// -- Helpers --

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}
function rand(min: number, max: number): number { return Math.floor(Math.random() * (max - min + 1)) + min; }

function ingredientTable(ings: Array<{ qty: string; unit: string; item: string }>): string {
  const qw = Math.max(3, ...ings.map((i) => i.qty.length));
  const uw = Math.max(4, ...ings.map((i) => i.unit.length));
  const iw = Math.max(10, ...ings.map((i) => i.item.length));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const h = `| ${pad("Qty", qw)} | ${pad("Unit", uw)} | ${pad("Ingredient", iw)} |`;
  const sep = `| ${"-".repeat(qw)} | ${"-".repeat(uw)} | ${"-".repeat(iw)} |`;
  const rows = ings.map((i) => `| ${pad(i.qty, qw)} | ${pad(i.unit, uw)} | ${pad(i.item, iw)} |`);
  return [h, sep, ...rows].join("\n");
}

function toMarkdown(r: { title: string; tags: string[]; servings: number; prepMinutes: number; cookMinutes: number; ingredients: Array<{ qty: string; unit: string; item: string }>; instructions: string; notes?: string }): string {
  const now = new Date().toISOString();
  const lines = [
    "---", `title: "${r.title}"`,
    `tags: [${r.tags.map((t) => `"${t}"`).join(", ")}]`,
    `servings: ${r.servings}`, `prepMinutes: ${r.prepMinutes}`, `cookMinutes: ${r.cookMinutes}`,
    `createdAt: ${now}`, `updatedAt: ${now}`, "---", "",
    "## Ingredients", "", ingredientTable(r.ingredients), "",
    "## Instructions", "", r.instructions, "",
  ];
  if (r.notes) lines.push("## Notes", "", r.notes, "");
  return lines.join("\n");
}

// -- Data pools --

const bookThemes = [
  { name: "Italian Classics", tags: ["italian", "pasta", "mediterranean", "comfort food"], cuisine: "italian" },
  { name: "Asian Street Food", tags: ["asian", "street food", "spicy", "noodles"], cuisine: "asian" },
  { name: "French Bistro", tags: ["french", "bistro", "classic", "elegant"], cuisine: "french" },
  { name: "Mexican Fiesta", tags: ["mexican", "spicy", "latin", "fiesta"], cuisine: "mexican" },
  { name: "Indian Kitchen", tags: ["indian", "curry", "spicy", "aromatic"], cuisine: "indian" },
  { name: "Mediterranean Diet", tags: ["mediterranean", "healthy", "fresh", "olive oil"], cuisine: "mediterranean" },
  { name: "American BBQ", tags: ["bbq", "grilling", "american", "smoky"], cuisine: "american" },
  { name: "Breakfast & Brunch", tags: ["breakfast", "brunch", "morning", "eggs"], cuisine: "breakfast" },
  { name: "Soups & Stews", tags: ["soup", "stew", "comfort food", "one-pot"], cuisine: "soup" },
  { name: "Vegetarian Delights", tags: ["vegetarian", "healthy", "plant-based", "fresh"], cuisine: "vegetarian" },
  { name: "Baking Fundamentals", tags: ["baking", "dessert", "pastry", "bread"], cuisine: "baking" },
  { name: "Quick Weeknight", tags: ["quick", "easy", "weeknight", "30-minute"], cuisine: "quick" },
  { name: "Holiday Favorites", tags: ["holiday", "celebration", "festive", "special"], cuisine: "holiday" },
  { name: "Healthy Meal Prep", tags: ["healthy", "meal prep", "high protein", "clean eating"], cuisine: "healthy" },
  { name: "Cocktails & Drinks", tags: ["cocktail", "drink", "beverage", "refreshing"], cuisine: "drinks" },
  { name: "Japanese Home Cooking", tags: ["japanese", "umami", "rice", "simple"], cuisine: "japanese" },
  { name: "Korean Favorites", tags: ["korean", "fermented", "spicy", "banchan"], cuisine: "korean" },
  { name: "Thai Essentials", tags: ["thai", "spicy", "aromatic", "balance"], cuisine: "thai" },
  { name: "Middle Eastern", tags: ["middle eastern", "spices", "grains", "mezze"], cuisine: "middleeastern" },
  { name: "Seafood Collection", tags: ["seafood", "fish", "shellfish", "coastal"], cuisine: "seafood" },
];

const proteins: Record<string, string[]> = {
  italian: ["chicken breast", "Italian sausage", "ground beef", "shrimp", "pancetta", "prosciutto", "veal cutlet"],
  asian: ["chicken thigh", "pork belly", "shrimp", "tofu", "beef sirloin", "duck breast", "squid"],
  french: ["duck breast", "chicken thigh", "beef tenderloin", "salmon fillet", "lamb rack", "pork loin", "mussels"],
  mexican: ["chicken thigh", "ground beef", "carnitas pork", "chorizo", "shrimp", "black beans", "pinto beans"],
  indian: ["chicken thigh", "lamb shoulder", "paneer", "chickpeas", "lentils", "shrimp", "ground lamb"],
  mediterranean: ["chicken breast", "lamb chops", "feta cheese", "halloumi", "chickpeas", "white fish", "squid"],
  american: ["beef brisket", "pork ribs", "chicken wings", "ground beef patties", "pulled pork", "hot dogs", "turkey breast"],
  breakfast: ["bacon", "eggs", "sausage links", "smoked salmon", "ham", "turkey bacon"],
  soup: ["chicken thigh", "beef chuck", "Italian sausage", "white beans", "lentils", "shrimp", "ham hock"],
  vegetarian: ["tofu", "tempeh", "chickpeas", "black beans", "lentils", "paneer", "seitan", "mushrooms"],
  baking: ["butter", "eggs", "cream cheese", "heavy cream", "chocolate chips", "mascarpone"],
  quick: ["chicken breast", "ground turkey", "shrimp", "salmon fillet", "sausage", "eggs", "canned tuna"],
  holiday: ["turkey breast", "prime rib", "ham", "lamb leg", "Cornish hen", "lobster tail", "beef tenderloin"],
  healthy: ["chicken breast", "salmon fillet", "tofu", "turkey breast", "shrimp", "tempeh", "lean ground turkey"],
  drinks: ["vodka", "gin", "rum", "tequila", "bourbon", "prosecco", "espresso"],
  japanese: ["salmon fillet", "pork belly", "chicken thigh", "tofu", "shrimp", "tuna", "beef sirloin"],
  korean: ["beef short ribs", "pork belly", "chicken thigh", "tofu", "squid", "kimchi"],
  thai: ["chicken thigh", "shrimp", "pork", "tofu", "beef", "squid", "fish fillet"],
  middleeastern: ["lamb shoulder", "chicken thigh", "chickpeas", "ground beef", "halloumi", "falafel mix"],
  seafood: ["salmon", "cod", "shrimp", "lobster", "scallops", "mussels", "tuna steak", "crab"],
};

const vegetables = [
  "onion, diced", "garlic cloves, minced", "bell pepper, sliced", "carrots, diced", "celery, diced",
  "tomatoes, chopped", "spinach leaves", "zucchini, sliced", "mushrooms, sliced", "broccoli florets",
  "green beans", "corn kernels", "peas", "potatoes, cubed", "sweet potato, cubed",
  "kale, chopped", "cabbage, shredded", "eggplant, cubed", "cauliflower florets", "asparagus spears",
  "green onions, sliced", "jalapeno, minced", "ginger, grated", "lemongrass, bruised", "shallots, minced",
];

const pantry = [
  "olive oil", "vegetable oil", "sesame oil", "butter", "coconut oil",
  "soy sauce", "fish sauce", "Worcestershire sauce", "hot sauce", "vinegar",
  "chicken stock", "vegetable stock", "coconut milk", "crushed tomatoes", "tomato paste",
  "all-purpose flour", "sugar", "brown sugar", "honey", "maple syrup",
  "salt", "black pepper", "cumin", "paprika", "chili powder",
  "oregano", "basil", "thyme", "rosemary", "cilantro",
  "rice", "pasta", "bread", "tortillas", "noodles",
];

const quantities = ["1", "2", "3", "4", "1/2", "1/4", "3/4", "1 1/2", "2 1/2"];
const units = ["cup", "cups", "tbsp", "tsp", "oz", "lb", "g", "ml", "cloves", "bunch", ""];

const cookingVerbs = [
  "Heat oil in a large skillet over medium-high heat.",
  "Preheat oven to 375F (190C).",
  "Bring a large pot of salted water to a boil.",
  "Heat a wok or large pan over high heat.",
  "Preheat your grill to medium-high.",
  "In a large Dutch oven, warm the oil over medium heat.",
  "Set up your mise en place before starting.",
];

const cookingSteps = [
  "Season the protein generously with salt and pepper on all sides.",
  "Cook until golden brown on the bottom, about 3-4 minutes, then flip.",
  "Add the aromatics and cook until fragrant, about 1 minute.",
  "Deglaze the pan with a splash of wine or stock, scraping up any browned bits.",
  "Add the vegetables and cook until tender-crisp, about 5 minutes.",
  "Stir in the sauce and bring to a simmer.",
  "Reduce heat to low, cover, and cook for 15-20 minutes until tender.",
  "Transfer to a baking dish and place in the preheated oven.",
  "Bake until bubbly and golden on top, about 25 minutes.",
  "Remove from heat and let rest for 5 minutes before serving.",
  "Garnish with fresh herbs and serve immediately.",
  "Taste and adjust seasoning with salt, pepper, and a squeeze of citrus.",
  "Toss everything together until well coated.",
  "Simmer gently, stirring occasionally, until thickened.",
  "Cook the pasta according to package directions until al dente.",
  "Drain and reserve 1 cup of the cooking liquid.",
  "Fold in the cheese and stir until melted and creamy.",
  "Let cool slightly before slicing. Serve warm or at room temperature.",
  "Blend until smooth, adding liquid as needed for desired consistency.",
  "Chill in the refrigerator for at least 1 hour before serving.",
  "Whisk together the dry ingredients in a large bowl.",
  "In a separate bowl, combine the wet ingredients.",
  "Fold the wet mixture into the dry ingredients until just combined. Do not overmix.",
  "Pour batter into the prepared pan and smooth the top.",
  "Knead the dough on a floured surface for 8-10 minutes until smooth and elastic.",
  "Cover with a damp towel and let rise in a warm place for 1 hour.",
  "Punch down the dough and shape as desired.",
  "Grill each side for 3-4 minutes until charred in spots.",
  "Baste with the marinade during the last few minutes of cooking.",
  "Slice against the grain for maximum tenderness.",
];

const noteTemplates = [
  "Can be made ahead and stored in the fridge for up to 3 days.",
  "Freezes well for up to 3 months. Thaw overnight in the refrigerator.",
  "For extra flavor, marinate the protein overnight.",
  "Substitute any seasonal vegetables you have on hand.",
  "Leftovers taste even better the next day as the flavors meld.",
  "For a spicier version, add more chili flakes or hot sauce to taste.",
  "Pairs well with a simple green salad and crusty bread.",
  "This recipe doubles easily for a crowd.",
  "Kids love this one -- it's a great way to sneak in extra vegetables.",
  "Use the best quality ingredients you can find; it makes a difference.",
];

const dishTypes: Record<string, string[]> = {
  italian: ["Spaghetti", "Penne", "Risotto", "Lasagna", "Gnocchi", "Ravioli", "Osso Buco", "Bruschetta", "Focaccia", "Minestrone", "Panzanella", "Arancini", "Tiramisu", "Panna Cotta", "Carpaccio", "Saltimbocca", "Cacciatore", "Primavera", "Bolognese", "Carbonara", "Aglio e Olio", "Caprese", "Frittata", "Polenta", "Piccata", "Marsala", "Puttanesca", "Amatriciana", "Cacio e Pepe", "Pomodoro", "Arrabiata", "Milanese"],
  asian: ["Pad Thai", "Pho", "Ramen", "Dumplings", "Spring Rolls", "Fried Rice", "Satay", "Bao Buns", "Bibimbap", "Teriyaki Bowl", "Dan Dan Noodles", "Mapo Tofu", "Laksa", "Banh Mi", "Tom Yum", "Char Siu", "Gyoza", "Tempura", "Katsu", "Soba Noodles", "Congee", "Kimchi Jjigae", "Bulgogi", "Japchae", "Miso Soup", "Okonomiyaki", "Takoyaki", "Green Curry", "Massaman Curry", "Som Tum", "Larb", "Rendang"],
  french: ["Coq au Vin", "Beef Bourguignon", "Ratatouille", "Quiche Lorraine", "Croque Monsieur", "Bouillabaisse", "Cassoulet", "Soupe a l'Oignon", "Tarte Tatin", "Crepes", "Madeleines", "Profiteroles", "Nicoise Salad", "Steak Frites", "Confit de Canard", "Gratin Dauphinois", "Croissants", "Souffle", "Mousse au Chocolat", "Creme Brulee", "Bechamel Sauce", "Bearnaise Sauce", "Hollandaise", "Pot-au-Feu", "Blanquette de Veau", "Pissaladiere", "Gougeres", "Flamiche", "Clafoutis", "Financiers", "Palmiers", "Mille-feuille"],
  mexican: ["Tacos al Pastor", "Chicken Enchiladas", "Guacamole", "Churros", "Pozole", "Tamales", "Chile Rellenos", "Elote", "Quesadillas", "Chilaquiles", "Carne Asada", "Mole Poblano", "Tostadas", "Sopes", "Huevos Rancheros", "Flan", "Tres Leches Cake", "Arroz con Pollo", "Birria", "Carnitas", "Cochinita Pibil", "Pico de Gallo", "Salsa Verde", "Mexican Rice", "Refried Beans", "Ceviche", "Esquites", "Gorditas", "Molletes", "Pan de Muerto", "Horchata", "Agua Fresca"],
  indian: ["Butter Chicken", "Palak Paneer", "Biryani", "Dal Tadka", "Samosa", "Naan Bread", "Tikka Masala", "Vindaloo", "Korma", "Chana Masala", "Aloo Gobi", "Malai Kofta", "Rogan Josh", "Dosa", "Idli", "Raita", "Mango Chutney", "Gulab Jamun", "Kheer", "Jalebi", "Tandoori Chicken", "Keema", "Saag", "Rajma", "Pakora", "Bhaji", "Pulao", "Dhokla", "Pav Bhaji", "Chole", "Rasam", "Uttapam"],
  mediterranean: ["Greek Salad", "Hummus", "Falafel", "Moussaka", "Shakshuka", "Spanakopita", "Tzatziki", "Baba Ganoush", "Tabbouleh", "Fattoush", "Lamb Kofta", "Dolma", "Lahmacun", "Pita Bread", "Baklava", "Grilled Halloumi", "Paella", "Gazpacho", "Patatas Bravas", "Croquetas", "Imam Bayildi", "Muhammara", "Kibbeh", "Mansaf", "Kousa Mahshi", "Kunafa", "Loukoumades", "Pastitsio", "Stifado", "Borek", "Manti", "Koshari"],
  american: ["Classic Burger", "BBQ Ribs", "Pulled Pork", "Brisket", "Coleslaw", "Mac and Cheese", "Cornbread", "Baked Beans", "Buffalo Wings", "Philly Cheesesteak", "Clam Chowder", "Jambalaya", "Gumbo", "Po'Boy", "Cobb Salad", "BLT", "Meatloaf", "Pot Roast", "Chili", "Fried Chicken", "Grits", "Biscuits and Gravy", "Apple Pie", "Pecan Pie", "Brownies", "Key Lime Pie", "Banana Pudding", "Smoked Turkey", "Baby Back Ribs", "Tri-Tip", "Burnt Ends", "Beer Can Chicken"],
  breakfast: ["Eggs Benedict", "Pancakes", "French Toast", "Avocado Toast", "Breakfast Burrito", "Granola", "Smoothie Bowl", "Shakshuka", "Omelette", "Waffles", "Chia Pudding", "Overnight Oats", "Acai Bowl", "Eggs Florentine", "Croque Madame", "Huevos Rancheros", "Bagel and Lox", "Breakfast Hash", "Cinnamon Rolls", "Scones", "Muffins", "Dutch Baby", "Crepes", "Fruit Salad", "Yogurt Parfait", "Quiche", "Frittata", "Baked Oatmeal", "Breakfast Sandwich", "Coffee Cake", "Banana Bread", "Popovers"],
  soup: ["Chicken Noodle", "Tomato Bisque", "French Onion", "Minestrone", "Clam Chowder", "Pho", "Tom Yum", "Beef Stew", "Chili", "Lentil Soup", "Butternut Squash", "Potato Leek", "Miso Soup", "Gazpacho", "Tortilla Soup", "Lobster Bisque", "Split Pea", "Gumbo", "Borscht", "Pozole", "Wonton Soup", "Ramen Broth", "Mulligatawny", "Ribollita", "Cioppino", "Avgolemono", "Hot and Sour", "Caldo Verde", "Cock-a-Leekie", "Bouillabaisse", "Congee", "Laksa"],
  vegetarian: ["Buddha Bowl", "Veggie Stir-Fry", "Mushroom Risotto", "Eggplant Parmesan", "Falafel Wrap", "Cauliflower Steak", "Stuffed Peppers", "Veggie Curry", "Black Bean Tacos", "Caprese Salad", "Ratatouille", "Spinach Lasagna", "Lentil Bolognese", "Pad Thai Tofu", "Vegetable Tempura", "Greek Stuffed Tomatoes", "Quinoa Salad", "Sweet Potato Curry", "Jackfruit Tacos", "Mushroom Bourguignon", "Tofu Scramble", "Veggie Paella", "Potato Gnocchi", "Pesto Pasta", "Shakshuka", "Spring Rolls", "Aloo Gobi", "Beet Burgers", "Corn Fritters", "Mac and Cheese", "Minestrone", "Gazpacho"],
  baking: ["Sourdough Bread", "Chocolate Cake", "Apple Pie", "Croissants", "Cinnamon Rolls", "Baguette", "Brownies", "Banana Bread", "Scones", "Focaccia", "Pretzels", "Challah", "Brioche", "Pita Bread", "Pizza Dough", "Lemon Bars", "Cheesecake", "Macarons", "Eclairs", "Danish Pastry", "Shortbread", "Blondies", "Carrot Cake", "Red Velvet Cake", "Angel Food Cake", "Pound Cake", "Tart Crust", "Puff Pastry", "Churros", "Madeleines", "Biscotti", "Pavlova"],
  quick: ["One-Pot Pasta", "Sheet Pan Chicken", "15-Minute Stir-Fry", "Quick Tacos", "Quesadillas", "Fried Rice", "Grilled Cheese", "Omelette", "Shrimp Scampi", "Chicken Caesar Wrap", "Salmon Teriyaki", "Turkey Meatballs", "Pesto Pasta", "Black Bean Soup", "Egg Fried Rice", "Fish Tacos", "Caprese Sandwich", "BLT Wrap", "Garlic Butter Shrimp", "Chicken Quesadilla", "Tuna Melt", "Sausage and Peppers", "Shakshuka", "Carbonara", "Thai Basil Chicken", "Honey Garlic Chicken", "Lemon Herb Salmon", "Beef and Broccoli", "Chicken Fajitas", "Greek Pita", "Teriyaki Bowl", "Burrito Bowl"],
  holiday: ["Roast Turkey", "Glazed Ham", "Prime Rib", "Yorkshire Pudding", "Cranberry Sauce", "Stuffing", "Sweet Potato Casserole", "Green Bean Casserole", "Pumpkin Pie", "Pecan Pie", "Gingerbread Cookies", "Eggnog", "Mulled Wine", "Yule Log", "Beef Wellington", "Lamb Crown Roast", "Deviled Eggs", "Cheese Board", "Spinach Artichoke Dip", "Bruschetta", "Shrimp Cocktail", "Crab Cakes", "Mini Quiches", "Pigs in Blankets", "Fruit Tart", "Chocolate Truffles", "Sugar Cookies", "Panettone", "Stollen", "Latkes", "Brisket", "Challah"],
  healthy: ["Grilled Chicken Salad", "Quinoa Bowl", "Salmon with Greens", "Turkey Lettuce Wraps", "Zucchini Noodles", "Chicken and Veggies", "Sweet Potato Bowl", "Overnight Oats", "Protein Smoothie", "Lentil Soup", "Cauliflower Rice Stir-Fry", "Baked Cod", "Greek Yogurt Parfait", "Chicken Meal Prep Box", "Egg Muffins", "Turkey Chili", "Shrimp Salad", "Tofu Scramble", "Brown Rice Bowl", "Veggie Wrap", "Stuffed Sweet Potato", "Edamame Bowl", "Miso Salmon", "Chicken Zoodle Soup", "Mediterranean Plate", "Thai Peanut Bowl", "Tuna Poke Bowl", "Roasted Chickpea Bowl", "Grilled Veggie Platter", "Berry Smoothie Bowl", "Avocado Egg Cups", "Lean Beef Stir-Fry"],
  drinks: ["Old Fashioned", "Margarita", "Mojito", "Espresso Martini", "Negroni", "Daiquiri", "Whiskey Sour", "Manhattan", "Mai Tai", "Pina Colada", "Moscow Mule", "Aperol Spritz", "Gin and Tonic", "Cosmopolitan", "Tom Collins", "Bloody Mary", "Mint Julep", "Caipirinha", "Paloma", "Sidecar", "French 75", "Amaretto Sour", "Dark and Stormy", "Irish Coffee", "Hot Toddy", "Mulled Wine", "Matcha Latte", "Chai Latte", "Golden Milk", "Virgin Mojito", "Lemonade", "Iced Tea"],
  japanese: ["Tonkotsu Ramen", "Gyudon", "Teriyaki Salmon", "Okonomiyaki", "Takoyaki", "Tempura", "Katsudon", "Onigiri", "Miso Soup", "Edamame", "Gyoza", "Udon", "Soba", "Chirashi Bowl", "Tamagoyaki", "Yakitori", "Nikujaga", "Karaage", "Chawanmushi", "Oyakodon", "Sukiyaki", "Shabu-Shabu", "Japanese Curry", "Matcha Ice Cream", "Dorayaki", "Mochi", "Dango", "Yakisoba", "Natto Rice", "Ochazuke", "Hayashi Rice", "Hamburg Steak"],
  korean: ["Bulgogi", "Kimchi Jjigae", "Bibimbap", "Japchae", "Tteokbokki", "Samgyeopsal", "Dakgalbi", "Sundubu Jjigae", "Kimbap", "Mandu", "Galbi", "Jajangmyeon", "Kongnamul", "Doenjang Jjigae", "Haemul Pajeon", "Hotteok", "Bingsu", "Yukgaejang", "Budae Jjigae", "Gamjatang", "Dak Bokkeum", "Jokbal", "Naengmyeon", "Hobak Jeon", "Kimchi Fried Rice", "Gyeran Jjim", "Bindaetteok", "Soondae", "Bossam", "Chapchae", "Army Stew", "Korean Fried Chicken"],
  thai: ["Pad Thai", "Green Curry", "Tom Yum", "Massaman Curry", "Som Tum", "Larb", "Pad See Ew", "Khao Pad", "Mango Sticky Rice", "Tom Kha Gai", "Red Curry", "Panang Curry", "Pad Krapow", "Satay", "Spring Rolls", "Papaya Salad", "Thai Basil Chicken", "Pineapple Fried Rice", "Crab Curry", "Fish Cakes", "Morning Glory Stir-Fry", "Thai Iced Tea", "Boat Noodles", "Khao Soi", "Gaeng Daeng", "Yum Woon Sen", "Kai Jeow", "Moo Ping", "Pla Rad Prik", "Rad Na", "Kao Moo Daeng", "Gai Yang"],
  middleeastern: ["Hummus", "Falafel", "Shawarma", "Kibbeh", "Fattoush", "Tabbouleh", "Baba Ganoush", "Lahmacun", "Mansaf", "Shakshuka", "Kunafa", "Baklava", "Musakhan", "Maqluba", "Kousa Mahshi", "Muhamara", "Kebab", "Kofta", "Fatteh", "Mujaddara", "Zarb", "Manakeesh", "Sambousek", "Sfeeha", "Warak Enab", "Freekeh Salad", "Shish Tawook", "Harissa Chicken", "Lamb Tagine", "Couscous Royale", "Merguez", "Chermoula Fish"],
  seafood: ["Grilled Salmon", "Fish and Chips", "Lobster Thermidor", "Shrimp Scampi", "Crab Cakes", "Clam Linguine", "Seared Scallops", "Fish Tacos", "Cioppino", "Mussels Mariniere", "Coconut Shrimp", "Tuna Poke", "Ceviche", "Grilled Swordfish", "Baked Cod", "Calamari", "Paella", "Bouillabaisse", "Shrimp and Grits", "Lobster Roll", "Oysters Rockefeller", "Smoked Salmon Platter", "Prawn Curry", "Fish Pie", "Salmon Teriyaki", "Blackened Catfish", "Ahi Tuna Steak", "Garlic Butter Crab", "Stuffed Squid", "Seafood Chowder", "Pan-Seared Trout", "Thai Fish Cakes"],
};

function generateRecipe(dishName: string, cuisine: string): { title: string; tags: string[]; servings: number; prepMinutes: number; cookMinutes: number; ingredients: Array<{ qty: string; unit: string; item: string }>; instructions: string; notes?: string } {
  const theme = bookThemes.find((b) => b.cuisine === cuisine) ?? bookThemes[0];
  const tags = pickN(theme.tags, rand(2, 3));

  const numIngs = rand(4, 9);
  const ingredients: Array<{ qty: string; unit: string; item: string }> = [];

  // Add protein
  const pool = proteins[cuisine] ?? proteins.italian;
  ingredients.push({ qty: pick(quantities), unit: pick(["lb", "g", "oz", ""]), item: pick(pool) });

  // Add vegetables
  for (const v of pickN(vegetables, rand(2, 4))) {
    ingredients.push({ qty: pick(quantities), unit: pick(units), item: v });
  }

  // Fill rest from pantry
  while (ingredients.length < numIngs) {
    ingredients.push({ qty: pick(quantities), unit: pick(units), item: pick(pantry) });
  }

  // Build instructions
  const steps = [pick(cookingVerbs)];
  const numSteps = rand(4, 7);
  for (const step of pickN(cookingSteps, numSteps)) {
    steps.push(step);
  }
  const instructions = steps.join("\n\n");

  const notes = Math.random() < 0.33 ? pick(noteTemplates) : undefined;

  return {
    title: dishName,
    tags,
    servings: pick([2, 4, 4, 6, 6, 8, 12]),
    prepMinutes: pick([5, 10, 10, 15, 15, 20, 30, 45, 60]),
    cookMinutes: cuisine === "drinks" ? 0 : pick([0, 10, 15, 20, 25, 30, 40, 45, 60, 90]),
    ingredients,
    instructions,
    notes,
  };
}

async function main() {
  const outDir = join(import.meta.dir);
  const zip = new JSZip();
  const selectedThemes = bookThemes.slice(0, NUM_BOOKS);
  let totalRecipes = 0;

  console.log(`Generating ${NUM_BOOKS} books with ${RECIPES_PER_BOOK} recipes each...`);

  for (const theme of selectedThemes) {
    const folder = zip.folder(theme.name)!;
    const dishes = dishTypes[theme.cuisine] ?? dishTypes.italian;

    // Generate RECIPES_PER_BOOK recipes, cycling through dish names if needed
    const recipes: string[] = [];
    const usedNames = new Set<string>();
    for (let i = 0; i < RECIPES_PER_BOOK; i++) {
      let name = dishes[i % dishes.length];
      // Add variation suffix if cycling
      if (i >= dishes.length) {
        const suffix = pick(["with Herbs", "Deluxe", "Family Style", "Quick", "Classic", "Spicy", "Creamy", "Grilled", "Baked", "Smoked"]);
        name = `${name} ${suffix}`;
      }
      if (usedNames.has(name)) name = `${name} II`;
      usedNames.add(name);

      const recipe = generateRecipe(name, theme.cuisine);
      const slug = slugify(name);
      folder.file(`${slug}.md`, toMarkdown(recipe));
      totalRecipes++;
    }

    folder.file("_book.yaml", [
      `name: "${theme.name}"`,
      `exportedAt: "${new Date().toISOString()}"`,
      `format: "recipepwa-v1"`,
      `recipeCount: ${RECIPES_PER_BOOK}`,
    ].join("\n"));

    console.log(`  ${theme.name}: ${RECIPES_PER_BOOK} recipes`);
  }

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const path = join(outDir, "large-test-data.zip");
  writeFileSync(path, buf);
  console.log(`\nGenerated ${path}`);
  console.log(`Total: ${NUM_BOOKS} books, ${totalRecipes} recipes`);
}

main();
